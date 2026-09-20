"use server";

import { desc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { integrationAccounts, syncRuns } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { clampDailyCap } from "@/lib/linkedin/enrich";
import {
  dailyCap,
  enrichCandidates,
  enrichEnabled,
  linkedInLocationCounts,
} from "@/server/sync/linkedin-enrich";
import { geocodeEnabled, geocodeProgress } from "@/server/sync/geocode";
import { getSetting, setSetting } from "@/lib/settings";
import { ensureSyncJobs } from "@/jobs/scheduler";
import {
  disconnectAccount,
  getAccount,
  myAddressList,
} from "@/server/sync/accounts";
import { runCalendarSync } from "@/server/sync/calendar";
import { resetGmailBackfill, runGmailSync } from "@/server/sync/gmail";
import { runLinkedInSync } from "@/server/sync/linkedin";
import {
  ensureExtensionToken,
  rotateExtensionToken,
} from "@/server/sync/extension-pairing";

// Server actions + data for the Settings → Integrations panel. Thin by
// design (CLAUDE.md): the engines live in server/sync/.

export type SyncRunSummary = {
  id: number;
  kind: string;
  status: string;
  statsJson: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
};

export type IntegrationStatus = {
  provider: "google" | "linkedin";
  connected: boolean;
  credsConfigured: boolean;
  accountEmail: string | null;
  status: string | null;
  lastError: string | null;
  scopes: string | null;
  myAddresses: string[];
  gmailBackfillDone: boolean;
  gmailHistoryId: string | null;
  calendarSyncToken: boolean;
  linkedinDomains: string[];
  linkedinSnapshotAt: number | null;
  recentRuns: SyncRunSummary[];
};

const RUN_KINDS: Record<"google" | "linkedin", string[]> = {
  google: ["gmail", "calendar"],
  linkedin: ["linkedin_api_sync"],
};

function statusFor(provider: "google" | "linkedin"): IntegrationStatus {
  const account = getAccount(provider);
  const credsConfigured =
    provider === "google"
      ? !!getSetting<string>("google.client_id") &&
        !!getSetting<string>("google.client_secret")
      : !!getSetting<string>("linkedin.client_id") &&
        !!getSetting<string>("linkedin.client_secret");
  let linkedinDomains: string[] = [];
  try {
    const parsed = JSON.parse(account?.linkedinDomains ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      linkedinDomains = parsed.filter((d): d is string => typeof d === "string");
    }
  } catch {
    // ignore
  }
  const recentRuns = db
    .select({
      id: syncRuns.id,
      kind: syncRuns.kind,
      status: syncRuns.status,
      statsJson: syncRuns.statsJson,
      error: syncRuns.error,
      startedAt: syncRuns.startedAt,
      finishedAt: syncRuns.finishedAt,
    })
    .from(syncRuns)
    .where(inArray(syncRuns.kind, RUN_KINDS[provider]))
    .orderBy(desc(syncRuns.startedAt))
    .limit(5)
    .all();
  return {
    provider,
    connected: !!account,
    credsConfigured,
    accountEmail: account?.accountEmail ?? null,
    status: account?.status ?? null,
    lastError: account?.lastError ?? null,
    scopes: account?.scopes ?? null,
    myAddresses: account ? myAddressList(account) : [],
    gmailBackfillDone: account?.gmailBackfillDone ?? false,
    gmailHistoryId: account?.gmailHistoryId ?? null,
    calendarSyncToken: !!account?.calendarSyncToken,
    linkedinDomains,
    linkedinSnapshotAt: account?.linkedinSnapshotAt ?? null,
    recentRuns,
  };
}

export type EnrichStatus = {
  enabled: boolean;
  dailyCap: number;
  /** Contacts with a LinkedIn URL still waiting for a location lookup. */
  queued: number;
  /** How many of those already have a location — the map's fill level. */
  located: number;
  linkedInContacts: number;
};

export type GeocodeStatus = {
  enabled: boolean;
  contactsWithLocation: number;
  contactsPlaced: number;
};

export async function readIntegrations(): Promise<{
  google: IntegrationStatus;
  linkedin: IntegrationStatus;
  extensionToken: string;
  enrich: EnrichStatus;
  geocode: GeocodeStatus;
  mapboxConfigured: boolean;
}> {
  await requireAuth();
  return {
    google: statusFor("google"),
    linkedin: statusFor("linkedin"),
    // Generated on first view; the extension needs it to post (SPEC §9c).
    extensionToken: ensureExtensionToken(),
    enrich: enrichStatusNow(),
    geocode: { enabled: geocodeEnabled(), ...geocodeProgress() },
    mapboxConfigured: (getSetting<string>("mapbox.token") ?? "") !== "",
  };
}

/** Mapbox rendering (SPEC §7a, owner-amended 2026-08-24). The token is a
 * public (pk.) token — it ships to the owner's own browser by design, so
 * plain settings storage is the right box, not the encrypted one. Empty
 * string clears, falling the map back to the bundled SVG. */
export async function setMapboxTokenAction(input: {
  token: string;
}): Promise<{ ok: true } | { error: string }> {
  await requireAuth();
  const token = input.token.trim();
  if (token !== "" && !/^pk\.[A-Za-z0-9._-]{20,}$/.test(token)) {
    return {
      error:
        "That doesn't look like a Mapbox public token — it should start with pk.",
    };
  }
  setSetting("mapbox.token", token || null);
  revalidatePath("/settings");
  revalidatePath("/map");
  return { ok: true };
}

/** SPEC decision #4: Nominatim, off by default — flipping this on is the
 * owner configuring the integration, which is what the outbound-host
 * allowlist entry has been waiting for. */
export async function setGeocodeEnabledAction(input: {
  enabled: boolean;
}): Promise<{ ok: true }> {
  await requireAuth();
  setSetting("geocode.enabled", input.enabled);
  // First batch inside a tick, not an interval away.
  ensureSyncJobs(Date.now());
  revalidatePath("/settings");
  revalidatePath("/map");
  return { ok: true };
}

function enrichStatusNow(): EnrichStatus {
  const counts = linkedInLocationCounts();
  return {
    enabled: enrichEnabled(),
    dailyCap: dailyCap(),
    queued: enrichCandidates(Date.now()).length,
    located: counts.located,
    linkedInContacts: counts.total,
  };
}

/** Turning it on is the owner accepting the tradeoff in SPEC §9d, so it is
 * off until they say otherwise. */
export async function setEnrichEnabledAction(input: {
  enabled: boolean;
}): Promise<{ ok: true }> {
  await requireAuth();
  setSetting("linkedin_enrich.enabled", input.enabled);
  revalidatePath("/settings");
  return { ok: true };
}

export async function setEnrichDailyCapAction(input: {
  cap: number;
}): Promise<{ ok: true; cap: number }> {
  await requireAuth();
  const cap = clampDailyCap(input.cap);
  setSetting("linkedin_enrich.daily_cap", cap);
  revalidatePath("/settings");
  return { ok: true, cap };
}

/** New token — invalidates any extension still holding the old one. */
export async function rotateExtensionTokenAction(): Promise<{ token: string }> {
  await requireAuth();
  const token = rotateExtensionToken();
  revalidatePath("/settings");
  return { token };
}

const credsInput = z.object({
  provider: z.enum(["google", "linkedin"]),
  clientId: z.string().trim().max(200),
  clientSecret: z.string().trim().max(200),
});

export async function saveIntegrationCredsAction(input: {
  provider: "google" | "linkedin";
  clientId: string;
  clientSecret: string;
}): Promise<{ error?: string }> {
  await requireAuth();
  const parsed = credsInput.safeParse(input);
  if (!parsed.success) return { error: "Invalid credentials." };
  setSetting(`${parsed.data.provider}.client_id`, parsed.data.clientId || null);
  // An empty secret field on save means "keep the stored one" so the
  // secret never has to round-trip to the browser.
  if (parsed.data.clientSecret) {
    setSetting(`${parsed.data.provider}.client_secret`, parsed.data.clientSecret);
  }
  revalidatePath("/settings");
  return {};
}

export async function updateMyAddressesAction(input: {
  addresses: string;
}): Promise<{ error?: string; rescan?: boolean }> {
  await requireAuth();
  const account = getAccount("google");
  if (!account) return { error: "Google is not connected." };
  const list = [
    ...new Set(
      input.addresses
        .split(/[\n,;]+/)
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.includes("@"))
    ),
  ];
  if (list.length === 0) return { error: "At least one address is required." };
  const before = [...new Set(myAddressList(account).map((a) => a.toLowerCase()))].sort();
  const changed = JSON.stringify(before) !== JSON.stringify([...list].sort());
  db.update(integrationAccounts)
    .set({ myAddresses: JSON.stringify(list), updatedAt: Date.now() })
    .where(eq(integrationAccounts.id, account.id))
    .run();
  if (changed) {
    // Direction and counterparts of every message depend on this list, so
    // what was already scanned is now wrong for any message that touched
    // the new or removed address. Re-read from the top; idempotent.
    resetGmailBackfill();
    ensureSyncJobs(Date.now());
  }
  revalidatePath("/settings");
  return { rescan: changed };
}

export async function disconnectIntegrationAction(input: {
  provider: "google" | "linkedin";
}): Promise<void> {
  await requireAuth();
  // Clear the backfill cursor before the row goes, or a reconnect (even
  // to a different mailbox) would resume a stale page token.
  if (input.provider === "google") resetGmailBackfill();
  disconnectAccount(input.provider);
  ensureSyncJobs(Date.now());
  revalidatePath("/settings");
}

export type SyncNowResult = { error?: string; summary?: string };

export async function syncNowAction(input: {
  kind: "gmail" | "calendar" | "linkedin";
}): Promise<SyncNowResult> {
  await requireAuth();
  try {
    if (input.kind === "gmail") {
      const stats = await runGmailSync();
      if (!stats) return { error: "Google is not connected." };
      return {
        summary: `${stats.messagesSeen} messages scanned, ${stats.interactionsAdded} interactions added${stats.backfillDone ? "" : " (backfill still in progress)"}.`,
      };
    }
    if (input.kind === "calendar") {
      const stats = await runCalendarSync();
      if (!stats) return { error: "Google is not connected." };
      return {
        summary: `${stats.eventsSeen} events scanned, ${stats.meetingsAdded} meetings added.`,
      };
    }
    const result = await runLinkedInSync();
    if (!result.ran) return { error: result.reason };
    return { summary: `${result.total} connections synced (run #${result.runId}).` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    revalidatePath("/settings");
    revalidatePath("/today");
    revalidatePath("/contacts");
  }
}
