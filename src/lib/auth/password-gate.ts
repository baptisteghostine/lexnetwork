import { getSetting, setSetting } from "@/lib/settings";
import {
  checkLogin,
  formatWait,
  lockoutMs,
  LOGIN_THROTTLE_KEY,
  NO_FAILURES,
  parseThrottleState,
  recordFailure,
  type LoginThrottleState,
} from "./login-throttle";
import { verifyPassword } from "./password";

// The one place a typed password is checked (SPEC Decisions §6, §14).
// Two doors use it — the login form and the connector's consent screen —
// and they must share one failure count: a guesser locked out of the login
// must not find a second, unthrottled way to test the same password.
//
// No next/headers here, so the scheduler, scripts and tests can import it.

const PASSWORD_HASH_KEY = "auth.password_hash";

export function getPasswordHash(): string | undefined {
  return getSetting<string>(PASSWORD_HASH_KEY);
}

// Read from the database on every attempt, never cached: the state has to
// survive a restart, and `npm run reset-password` clears it from another
// process while the server is up.
export function getLoginThrottle(): LoginThrottleState {
  return parseThrottleState(getSetting<unknown>(LOGIN_THROTTLE_KEY));
}

export function setLoginThrottle(state: LoginThrottleState): void {
  setSetting(LOGIN_THROTTLE_KEY, state);
}

/** A new password starts with a clean slate: any login lockout is lifted. */
export function setPasswordHash(hash: string): void {
  setSetting(PASSWORD_HASH_KEY, hash);
  setLoginThrottle(NO_FAILURES);
}

export type PasswordAttempt =
  | { ok: true }
  | { ok: false; error: string; reason: "no_password" | "locked" | "wrong" };

/**
 * Check a typed password against the stored hash, under the throttle.
 * From reading the state to writing it back there is no `await`, and
 * better-sqlite3 is synchronous, so concurrent submissions cannot
 * interleave and slip extra guesses past the count.
 */
export function attemptPassword(password: string, now = Date.now()): PasswordAttempt {
  const hash = getPasswordHash();
  if (!hash) {
    return { ok: false, reason: "no_password", error: "Rolo has no password yet — finish setup first." };
  }
  const throttle = getLoginThrottle();
  const gate = checkLogin(throttle, now);
  if (!gate.allowed) {
    // Refused before the password is looked at: a guess made during a
    // lockout learns nothing, and neither counts nor extends the wait.
    return {
      ok: false,
      reason: "locked",
      error: `Too many wrong passwords. Try again in ${formatWait(gate.retryAfterMs)}.`,
    };
  }
  if (!verifyPassword(password, hash)) {
    const next = recordFailure(throttle, now);
    setLoginThrottle(next);
    const lockout = lockoutMs(next.failures);
    return {
      ok: false,
      reason: "wrong",
      error:
        lockout > 0
          ? `Wrong password. Too many failed attempts — try again in ${formatWait(lockout)}.`
          : "Wrong password.",
    };
  }
  if (throttle.failures > 0) setLoginThrottle(NO_FAILURES);
  return { ok: true };
}
