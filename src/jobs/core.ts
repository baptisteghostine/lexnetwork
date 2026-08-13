// Pure scheduler decision logic (no DB, no clock) — see SCHEMA.md `jobs`.
// The loop in scheduler.ts feeds these with rows and a timestamp; keeping
// them pure is what makes backoff/reclaim unit-testable.

export const POLL_INTERVAL_MS = 15_000;
// A 'running' job older than this is presumed crashed and reclaimed.
export const LEASE_MS = 5 * 60_000;
// Completed job rows are pruned after this long.
export const PRUNE_AFTER_MS = 7 * 24 * 60 * 60_000;

export type JobRow = {
  id: number;
  status: string;
  attempts: number;
  maxAttempts: number;
  startedAt: number | null;
};

/** SCHEMA.md: run_at += 2^attempts * 30s. `attempts` includes the failed one. */
export function backoffDelayMs(attempts: number): number {
  return 2 ** attempts * 30_000;
}

export type JobOutcome =
  | { status: "success"; finishedAt: number }
  | { status: "pending"; runAt: number; lastError: string }
  | { status: "dead"; finishedAt: number; lastError: string };

/**
 * What happens to a claimed job after its handler ran (or threw).
 * `job.attempts` must already include the attempt that just finished.
 */
export function applyOutcome(
  job: Pick<JobRow, "attempts" | "maxAttempts">,
  error: string | null,
  now: number
): JobOutcome {
  if (error === null) return { status: "success", finishedAt: now };
  if (job.attempts >= job.maxAttempts) {
    return { status: "dead", finishedAt: now, lastError: error };
  }
  return {
    status: "pending",
    runAt: now + backoffDelayMs(job.attempts),
    lastError: error,
  };
}

/**
 * Crash recovery: a 'running' row whose lease expired goes back to pending
 * (its attempt already counted when claimed) — unless it's out of attempts,
 * in which case it's dead. Rows inside the lease window are left alone.
 */
export function reclaimDecision(
  job: JobRow,
  now: number,
  leaseMs: number = LEASE_MS
): "keep" | "pending" | "dead" {
  if (job.status !== "running") return "keep";
  if (job.startedAt !== null && now - job.startedAt < leaseMs) return "keep";
  return job.attempts >= job.maxAttempts ? "dead" : "pending";
}
