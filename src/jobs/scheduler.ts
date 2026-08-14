import { and, asc, desc, eq, isNotNull, isNull, lt, lte, ne, or } from "drizzle-orm";

import { DATA_DIR, db, rawDb } from "@/db/client";
import { jobs } from "@/db/schema";
import { runBackup } from "@/lib/backup/run";
import {
  applyOutcome,
  LEASE_MS,
  POLL_INTERVAL_MS,
  PRUNE_AFTER_MS,
  reclaimDecision,
} from "@/jobs/core";
import { ownerTimezone, runDigest } from "@/jobs/digest";
import { fireDueReminders } from "@/lib/reminders/fire";
import { getSetting } from "@/lib/settings";
import { localDateKey, nextLocalHour } from "@/lib/time";
import { getAccount } from "@/server/sync/accounts";
import { runCalendarSync } from "@/server/sync/calendar";
import { runGmailSync } from "@/server/sync/gmail";
import { runLinkedInSync } from "@/server/sync/linkedin";
import { runAiBatchTag } from "@/server/ai-batch";
import { runDedupeScan } from "@/server/dedupe-scan";
import {
  getVoyagerSession,
  isVoyagerEnabled,
  runVoyagerSync,
} from "@/server/sync/voyager";

// The in-process scheduler (CLAUDE.md: jobs table, no external broker).
// Durability lives in the `jobs` table and in domain ledgers like
// reminders.fired_at; this loop is stateless and safe to restart anytime.
//
// Reminder firing is swept inline on every tick rather than via per-fire
// job rows — reminders.fired_at is the exactly-once ledger, so the sweep
// is idempotent across crashes (SCHEMA.md notes this under `jobs`).

type Handler = (payloadJson: string | null) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  digest: async () => {
    await runDigest(Date.now());
  },
  ai_batch_tag: async (payloadJson) => {
    await runAiBatchTag(payloadJson);
  },
  gmail_sync: async () => {
    await runGmailSync();
  },
  calendar_sync: async () => {
    await runCalendarSync();
  },
  linkedin_sync: async () => {
    await runLinkedInSync();
  },
  linkedin_voyager_sync: async () => {
    await runVoyagerSync();
  },
  dedupe_scan: async () => {
    runDedupeScan();
  },
  backup: async () => {
    runBackup(rawDb, DATA_DIR);
  },
};

function providerActive(provider: "google" | "linkedin"): boolean {
  const account = getAccount(provider);
  return !!account && account.status !== "revoked";
}

// Recurring sync cadence (SPEC §9): Gmail 15 min, Calendar 30 min;
// LinkedIn snapshots move slowly — weekly (SPEC §9a/§9b). Each entry's
// `connected` gate decides whether its job should exist at all.
const SYNC_JOBS: {
  kind:
    | "gmail_sync"
    | "calendar_sync"
    | "linkedin_sync"
    | "linkedin_voyager_sync"
    | "dedupe_scan"
    | "backup";
  connected: () => boolean;
  intervalMs: number;
}[] = [
  { kind: "gmail_sync", connected: () => providerActive("google"), intervalMs: 15 * 60 * 1000 },
  { kind: "calendar_sync", connected: () => providerActive("google"), intervalMs: 30 * 60 * 1000 },
  { kind: "linkedin_sync", connected: () => providerActive("linkedin"), intervalMs: 7 * 24 * 3600 * 1000 },
  {
    kind: "linkedin_voyager_sync",
    // The weekly job exists only while the owner has both saved a session
    // and left the opt-in toggle on (SPEC §9b). "Sync now" bypasses this
    // gate deliberately — a manual run needs only the session.
    connected: () => isVoyagerEnabled() && getVoyagerSession() !== null,
    intervalMs: 7 * 24 * 3600 * 1000,
  },
  // Dedupe is always on (SPEC §10): the queue only fills as sources add
  // overlapping contacts, and an empty scan is cheap.
  { kind: "dedupe_scan", connected: () => true, intervalMs: 24 * 3600 * 1000 },
  // Nightly backup (SPEC §13) — always on; first run fires at first boot,
  // then every 24h from the last success, like dedupe_scan.
  { kind: "backup", connected: () => true, intervalMs: 24 * 3600 * 1000 },
];

/**
 * Keep one pending job per connected sync kind. Called at startup, after
 * each sync run, and right after a connect/toggle in Settings (so the
 * first sync starts within a tick, not an interval).
 */
export function ensureSyncJobs(now: number): void {
  for (const spec of SYNC_JOBS) {
    const pending = db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.kind, spec.kind), eq(jobs.status, "pending")))
      .get();
    if (!spec.connected()) {
      if (pending) db.delete(jobs).where(eq(jobs.id, pending.id)).run();
      continue;
    }
    if (pending) continue;
    // First run for a fresh connection fires immediately; steady-state
    // re-enqueues land one interval out.
    const last = db
      .select({ finishedAt: jobs.finishedAt })
      .from(jobs)
      .where(and(eq(jobs.kind, spec.kind), eq(jobs.status, "success")))
      .orderBy(desc(jobs.finishedAt))
      .limit(1)
      .get();
    const runAt = last?.finishedAt ? last.finishedAt + spec.intervalMs : now;
    enqueueJob({ kind: spec.kind, runAt, dedupeKey: `${spec.kind}:${runAt}` });
  }
}

export function enqueueJob(opts: {
  kind: string;
  runAt: number;
  dedupeKey?: string;
  payloadJson?: string;
}): void {
  db.insert(jobs)
    .values({
      kind: opts.kind,
      runAt: opts.runAt,
      dedupeKey: opts.dedupeKey ?? null,
      payloadJson: opts.payloadJson ?? null,
      status: "pending",
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
}

/**
 * Keep exactly one pending digest job aimed at the next digest hour in the
 * owner's timezone. Called at startup, after each digest run, and when
 * digest settings change (re-aims the pending row).
 */
export function ensureDigestJob(now: number): void {
  const tz = ownerTimezone();
  const hour = getSetting<number>("digest.hour") ?? 8;
  let runAt = nextLocalHour(tz, hour, now);
  let dedupeKey = `digest:${localDateKey(tz, runAt)}`;
  // A finished (success/dead) row already holding the target day's key
  // means that day's digest is spoken for — e.g. the owner moved the hour
  // later on a day whose digest already went out. Aim for the next day
  // instead of colliding with the UNIQUE dedupe key.
  const taken = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.dedupeKey, dedupeKey), ne(jobs.status, "pending")))
    .get();
  if (taken) {
    runAt = nextLocalHour(tz, hour, runAt);
    dedupeKey = `digest:${localDateKey(tz, runAt)}`;
  }
  const pending = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, "digest"), eq(jobs.status, "pending")))
    .get();
  if (pending) {
    // Never re-aim a row that is due-but-unfired (restart between the
    // digest hour and the first tick would skip that day's digest
    // entirely) or one mid-retry-backoff (attempts > 0) — the tick loop
    // owns both. Only a future, untouched row follows settings changes.
    if (pending.runAt > now && pending.attempts === 0 && pending.runAt !== runAt) {
      db.update(jobs)
        .set({ runAt, dedupeKey })
        .where(eq(jobs.id, pending.id))
        .run();
    }
    return;
  }
  enqueueJob({ kind: "digest", runAt, dedupeKey });
}

/**
 * Crash recovery (SCHEMA.md): expired 'running' leases re-run. Called at
 * startup AND every tick — a crash followed by a fast restart leaves the
 * row inside its lease window at startup, so someone has to look again
 * once the lease expires. The UPDATE re-checks status and started_at so a
 * job that legitimately finished (or was reclaimed by another process)
 * between the SELECT and the UPDATE isn't clobbered back to pending.
 */
export function reclaimStaleJobs(now: number): void {
  const running = db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "running"))
    .all();
  for (const j of running) {
    const decision = reclaimDecision(j, now, LEASE_MS);
    if (decision === "keep") continue;
    const guard = and(
      eq(jobs.id, j.id),
      eq(jobs.status, "running"),
      j.startedAt === null
        ? isNull(jobs.startedAt)
        : eq(jobs.startedAt, j.startedAt)
    );
    db.update(jobs)
      .set(
        decision === "pending"
          ? { status: "pending", runAt: now, startedAt: null }
          : {
              status: "dead",
              finishedAt: now,
              lastError: "Lease expired — process died mid-run.",
              // Dead rows must not squat on their dedupe key, or the next
              // enqueue of this kind silently no-ops for up to the prune
              // window.
              dedupeKey: null,
            }
      )
      .where(guard)
      .run();
  }
}

async function runDueJobs(now: number): Promise<void> {
  const due = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "pending"), lte(jobs.runAt, now)))
    .orderBy(asc(jobs.runAt))
    .limit(5)
    .all();
  for (const j of due) {
    // Compare-and-swap claim: the WHERE re-checks status so a second
    // process (clustered start, stray dev server on the same data dir)
    // can't double-run a job — the loser's UPDATE matches zero rows.
    const claimed = db
      .update(jobs)
      .set({ status: "running", startedAt: Date.now(), attempts: j.attempts + 1 })
      .where(and(eq(jobs.id, j.id), eq(jobs.status, "pending")))
      .run();
    if (claimed.changes === 0) continue;
    let error: string | null = null;
    try {
      const handler = HANDLERS[j.kind];
      if (!handler) throw new Error(`No handler for job kind '${j.kind}'`);
      await handler(j.payloadJson);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const outcome = applyOutcome(
      { attempts: j.attempts + 1, maxAttempts: j.maxAttempts },
      error,
      Date.now()
    );
    db.update(jobs)
      .set(
        outcome.status === "success"
          ? { status: "success", finishedAt: outcome.finishedAt }
          : outcome.status === "pending"
            ? {
                status: "pending",
                runAt: outcome.runAt,
                startedAt: null,
                lastError: outcome.lastError,
              }
            : {
                status: "dead",
                finishedAt: outcome.finishedAt,
                lastError: outcome.lastError,
                // Release the dedupe key: a dead gmail_sync/calendar_sync
                // row otherwise blocks every re-enqueue of that kind (same
                // key recomputed from the unchanged last success) until
                // pruning, stopping the sync for up to 7 days.
                dedupeKey: null,
              }
      )
      .where(eq(jobs.id, j.id))
      .run();
    // Recurring jobs re-enqueue their next run on completion.
    if (outcome.status !== "pending") {
      if (j.kind === "digest") ensureDigestJob(Date.now());
      if (SYNC_JOBS.some((s) => s.kind === j.kind)) ensureSyncJobs(Date.now());
    }
  }
}

function pruneOldJobs(now: number): void {
  db.delete(jobs)
    .where(
      and(
        or(eq(jobs.status, "success"), eq(jobs.status, "dead")),
        isNotNull(jobs.finishedAt),
        lt(jobs.finishedAt, now - PRUNE_AFTER_MS)
      )
    )
    .run();
}

async function tick(): Promise<void> {
  const now = Date.now();
  try {
    reclaimStaleJobs(now);
    fireDueReminders(now);
    await runDueJobs(now);
    pruneOldJobs(now);
  } catch (err) {
    // A failed tick must never kill the loop (e.g. migrations not applied
    // yet on a fresh install) — the next tick retries.
    console.error("[rolo-scheduler] tick failed:", err);
  }
}

declare global {
  // HMR-safe process-wide singleton (same pattern as db/client.ts).
  var __roloScheduler: ReturnType<typeof setInterval> | undefined;
}

/** Idempotent: safe under HMR and repeated imports. */
export function startScheduler(): void {
  if (globalThis.__roloScheduler) return;
  const now = Date.now();
  try {
    reclaimStaleJobs(now);
    ensureDigestJob(now);
    ensureSyncJobs(now);
  } catch (err) {
    console.error("[rolo-scheduler] startup init failed:", err);
  }
  const interval = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  // Never keep the process alive just for the loop.
  interval.unref?.();
  globalThis.__roloScheduler = interval;
  void tick();
  console.log("[rolo-scheduler] started (poll every %ds)", POLL_INTERVAL_MS / 1000);
}
