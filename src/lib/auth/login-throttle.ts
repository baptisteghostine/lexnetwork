// Failed-login throttle (SPEC Decisions §6). Pure decision logic only: the
// state lives in the `settings` table, read and written by the login action.
//
// One global counter, not one per client IP: Rolo has exactly one account, so
// every guess targets the same password whatever address it comes from, and a
// per-IP count is what rotating addresses walks around.

/** `settings` key holding the persisted `LoginThrottleState`. */
export const LOGIN_THROTTLE_KEY = "auth.login_throttle";

/** The failure that makes this many in a row starts the first lockout. */
export const LOCKOUT_THRESHOLD = 5;
export const BASE_LOCKOUT_MS = 30_000;
export const MAX_LOCKOUT_MS = 15 * 60_000;

export type LoginThrottleState = {
  /** Consecutive wrong passwords since the last successful login or reset. */
  failures: number;
  /** Epoch ms of the most recent one; 0 when there is none. */
  lastFailureAt: number;
};

export const NO_FAILURES: LoginThrottleState = { failures: 0, lastFailureAt: 0 };

export type LoginGate =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

/** What `settings` holds, or a clean slate when it holds nothing usable. */
export function parseThrottleState(raw: unknown): LoginThrottleState {
  if (typeof raw !== "object" || raw === null) return NO_FAILURES;
  const { failures, lastFailureAt } = raw as Record<string, unknown>;
  if (
    typeof failures !== "number" ||
    !Number.isInteger(failures) ||
    failures < 1 ||
    typeof lastFailureAt !== "number" ||
    !Number.isFinite(lastFailureAt)
  ) {
    return NO_FAILURES;
  }
  return { failures, lastFailureAt };
}

/**
 * How long logins stay refused after the `failures`-th consecutive wrong
 * password: nothing below the threshold, then 30 s doubling per further
 * failure, capped at 15 min.
 */
export function lockoutMs(failures: number): number {
  if (failures < LOCKOUT_THRESHOLD) return 0;
  // 2 ** n overflows to Infinity long before it could wrap; min() caps it.
  return Math.min(
    MAX_LOCKOUT_MS,
    BASE_LOCKOUT_MS * 2 ** (failures - LOCKOUT_THRESHOLD)
  );
}

/** Whether a login attempt may be checked against the password at `now`. */
export function checkLogin(state: LoginThrottleState, now: number): LoginGate {
  const lockout = lockoutMs(state.failures);
  if (lockout === 0) return { allowed: true };
  // Clamped to the lockout itself: a last failure stamped in the future (the
  // server clock was set back) must not hold the door shut for longer.
  const retryAfterMs = Math.min(lockout, state.lastFailureAt + lockout - now);
  return retryAfterMs > 0 ? { allowed: false, retryAfterMs } : { allowed: true };
}

/** The state after a wrong password at `now`. */
export function recordFailure(
  state: LoginThrottleState,
  now: number
): LoginThrottleState {
  return { failures: state.failures + 1, lastFailureAt: now };
}

/** "45 seconds", "1 minute", "8 minutes" — rounded up, never shorter than the wait. */
export function formatWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
