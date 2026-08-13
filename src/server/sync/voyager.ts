import "server-only";

import { createHash } from "node:crypto";

import { db } from "@/db/client";
import { syncRuns } from "@/db/schema";
import { getSessionSecret } from "@/lib/auth/secret";
import { decryptToken, encryptToken } from "@/lib/crypto";
import { scrubSecrets, type LinkedInSession } from "@/lib/linkedin/session";
import { voyagerToConnection } from "@/lib/linkedin/voyager";
import { getSetting, setSetting } from "@/lib/settings";
import { fetchAllConnections } from "@/lib/sync/linkedin-voyager";
import { executeLinkedInRows } from "@/server/linkedin-import";

// LinkedIn Voyager sync (SPEC §9b): the opt-in weekly pull of the owner's
// own connection list through LinkedIn's internal API, using a session
// cookie the owner pastes in. Feeds the exact import core the ZIP upload
// and the §9a API sync use — same identity ladder, same provenance rules,
// same job-change detection. Built on the owner's explicit instruction;
// the ToS tradeoff and the no-evasion constraints live in CLAUDE.md.

const SESSION_KEY = "linkedin_voyager.session";
const ENABLED_KEY = "linkedin_voyager.enabled";

/**
 * The cookie is a bearer credential, so it gets the same at-rest encryption
 * as OAuth tokens (lib/crypto): the SQLite file is backed up and copied
 * around, and a live LinkedIn login must not sit plaintext in those copies.
 * Rotating the session secret invalidates it — surfaced as "reconnect".
 */
export function getVoyagerSession(): LinkedInSession | null {
  const boxed = getSetting<string>(SESSION_KEY);
  if (!boxed) return null;
  const plain = decryptToken(boxed, getSessionSecret());
  if (plain === null) return null;
  try {
    const parsed = JSON.parse(plain) as Partial<LinkedInSession>;
    if (!parsed.liAt || !parsed.jsessionId) return null;
    return { liAt: parsed.liAt, jsessionId: parsed.jsessionId };
  } catch {
    return null;
  }
}

export function setVoyagerSession(session: LinkedInSession | null): void {
  setSetting(
    SESSION_KEY,
    session === null
      ? null
      : encryptToken(JSON.stringify(session), getSessionSecret())
  );
}

export function isVoyagerEnabled(): boolean {
  return getSetting<boolean>(ENABLED_KEY) ?? false;
}

export function setVoyagerEnabled(enabled: boolean): void {
  setSetting(ENABLED_KEY, enabled);
}

export type VoyagerSyncResult =
  | { ran: false; reason: string }
  | { ran: true; runId: number; total: number };

/**
 * A stable hash of the connection list, stored as the run's file hash so
 * the report shows at a glance whether anything moved since last week.
 */
function hashConnections(identifiers: string[]): string {
  const sorted = [...identifiers].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

/** One sync run. Returns why it didn't run when it can't. */
export async function runVoyagerSync(): Promise<VoyagerSyncResult> {
  const session = getVoyagerSession();
  if (session === null) {
    return {
      ran: false,
      reason:
        "No LinkedIn session saved — paste the li_at and JSESSIONID cookies in Settings.",
    };
  }

  const startedAt = Date.now();
  let connections;
  try {
    connections = await fetchAllConnections(session);
  } catch (error) {
    // The message lands in sync_runs.error and jobs.last_error, both
    // rendered in the UI — it must never carry a live session cookie.
    const message = scrubSecrets(
      error instanceof Error ? error.message : String(error)
    );
    db.insert(syncRuns)
      .values({
        kind: "linkedin_voyager_sync",
        status: "failed",
        error: message,
        startedAt,
        finishedAt: Date.now(),
      })
      .run();
    throw new Error(message);
  }

  // Zero connections is never a legitimate result for an account with a
  // session worth syncing — it means the response shape drifted or the
  // session is half-valid. Failing keeps a silent no-op from looking like
  // success (SPEC §9b: fail loud).
  if (connections.length === 0) {
    const message =
      "LinkedIn returned no connections. The response shape has probably changed — check src/lib/linkedin/voyager.ts against a fresh payload.";
    db.insert(syncRuns)
      .values({
        kind: "linkedin_voyager_sync",
        status: "failed",
        error: message,
        startedAt,
        finishedAt: Date.now(),
      })
      .run();
    throw new Error(message);
  }

  const rows = connections.map(voyagerToConnection);
  const { runId, report } = executeLinkedInRows({
    connections: rows,
    // Voyager pulls the connection list only; the ZIP path remains the way
    // conversations enter the timeline.
    messages: [],
    ownerName: null,
    runKind: "linkedin_voyager_sync",
    fileName: `voyager-sync-${new Date(startedAt).toISOString().slice(0, 10)}`,
    fileSha256: hashConnections(connections.map((c) => c.publicIdentifier)),
  });

  return { ran: true, runId, total: report.stats.total };
}
