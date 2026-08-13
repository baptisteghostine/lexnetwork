"use server";

import { desc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { integrationAccounts, syncRuns } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/settings";
import { ensureSyncJobs } from "@/jobs/scheduler";
import {
  disconnectAccount,
  getAccount,
  myAddressList,
} from "@/server/sync/accounts";
import { runCalendarSync } from "@/server/sync/calendar";
import { runGmailSync } from "@/server/sync/gmail";
import { runLinkedInSync } from "@/server/sync/linkedin";

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

export async function readIntegrations(): Promise<{
  google: IntegrationStatus;
  linkedin: IntegrationStatus;
}> {
  await requireAuth();
  return { google: statusFor("google"), linkedin: statusFor("linkedin") };
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
}): Promise<{ error?: string }> {
  await requireAuth();
  const account = getAccount("google");
  if (!account) return { error: "Google is not connected." };
  const list = input.addresses
    .split(/[\n,;]+/)
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.includes("@"));
  if (list.length === 0) return { error: "At least one address is required." };
  db.update(integrationAccounts)
    .set({ myAddresses: JSON.stringify(list), updatedAt: Date.now() })
    .where(eq(integrationAccounts.id, account.id))
    .run();
  revalidatePath("/settings");
  return {};
}

export async function disconnectIntegrationAction(input: {
  provider: "google" | "linkedin";
}): Promise<void> {
  await requireAuth();
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
