import { and, asc, eq, isNotNull, lt, lte, or } from "drizzle-orm";

import { db } from "@/db/client";
import { jobs } from "@/db/schema";
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

// The in-process scheduler (CLAUDE.md: jobs table, no external broker).
// Durability lives in the `jobs` table and in domain ledgers like
// reminders.fired_at; this loop is stateless and safe to restart anytime.
//
// Reminder firing is swept inline on every tick rather than via per-fire
// job rows — reminders.fired_at is the exactly-once ledger, so the sweep
// is idempotent across crashes (SCHEMA.md notes this under `jobs`).

type Handler = () => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  digest: async () => {
    await runDigest(Date.now());
  },
};

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
  const runAt = nextLocalHour(tz, hour, now);
  const dedupeKey = `digest:${localDateKey(tz, runAt)}`;
  const pending = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, "digest"), eq(jobs.status, "pending")))
    .get();
  if (pending) {
    if (pending.runAt !== runAt) {
      db.update(jobs)
        .set({ runAt, dedupeKey })
        .where(eq(jobs.id, pending.id))
        .run();
    }
    return;
  }
  enqueueJob({ kind: "digest", runAt, dedupeKey });
}

/** Startup crash recovery (SCHEMA.md): expired 'running' leases re-run. */
export function reclaimStaleJobs(now: number): void {
  const running = db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "running"))
    .all();
  for (const j of running) {
    const decision = reclaimDecision(j, now, LEASE_MS);
    if (decision === "keep") continue;
    db.update(jobs)
      .set(
        decision === "pending"
          ? { status: "pending", runAt: now, startedAt: null }
          : {
              status: "dead",
              finishedAt: now,
              lastError: "Lease expired — process died mid-run.",
            }
      )
      .where(eq(jobs.id, j.id))
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
      await handler();
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
              }
      )
      .where(eq(jobs.id, j.id))
      .run();
    // Recurring jobs re-enqueue their next run on completion.
    if (j.kind === "digest" && outcome.status !== "pending") {
      ensureDigestJob(Date.now());
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
