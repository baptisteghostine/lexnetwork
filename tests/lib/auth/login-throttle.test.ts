import { describe, expect, it } from "vitest";

import {
  BASE_LOCKOUT_MS,
  checkLogin,
  formatWait,
  LOCKOUT_THRESHOLD,
  lockoutMs,
  MAX_LOCKOUT_MS,
  NO_FAILURES,
  parseThrottleState,
  recordFailure,
  type LoginThrottleState,
} from "@/lib/auth/login-throttle";

const T0 = 1_800_000_000_000;

/** `count` wrong passwords, each made the instant the previous lockout ends. */
function failTimes(count: number, start = T0): LoginThrottleState {
  let state = NO_FAILURES;
  let now = start;
  for (let i = 0; i < count; i++) {
    state = recordFailure(state, now);
    now += lockoutMs(state.failures);
  }
  return state;
}

describe("lockoutMs", () => {
  it("is zero below the threshold", () => {
    for (let n = 0; n < LOCKOUT_THRESHOLD; n++) expect(lockoutMs(n)).toBe(0);
  });

  it("starts at 30 s on the 5th failure and doubles per failure after", () => {
    expect([5, 6, 7, 8, 9].map(lockoutMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000,
    ]);
  });

  it("caps at 15 minutes, however many failures pile up", () => {
    expect(lockoutMs(10)).toBe(MAX_LOCKOUT_MS);
    expect(lockoutMs(11)).toBe(MAX_LOCKOUT_MS);
    expect(lockoutMs(5_000)).toBe(MAX_LOCKOUT_MS);
    expect(MAX_LOCKOUT_MS).toBe(15 * 60_000);
  });
});

describe("checkLogin", () => {
  it("allows a first attempt", () => {
    expect(checkLogin(NO_FAILURES, T0)).toEqual({ allowed: true });
  });

  it("allows immediate retries for the first four failures", () => {
    for (let n = 1; n < LOCKOUT_THRESHOLD; n++) {
      expect(checkLogin(failTimes(n), T0)).toEqual({ allowed: true });
    }
  });

  it("refuses right after the 5th failure, with the full wait", () => {
    const state = failTimes(5);
    expect(checkLogin(state, state.lastFailureAt)).toEqual({
      allowed: false,
      retryAfterMs: BASE_LOCKOUT_MS,
    });
  });

  it("counts the wait down and reopens exactly when it ends", () => {
    const state = failTimes(5);
    const at = state.lastFailureAt;
    expect(checkLogin(state, at + 10_000)).toEqual({
      allowed: false,
      retryAfterMs: 20_000,
    });
    expect(checkLogin(state, at + BASE_LOCKOUT_MS - 1)).toEqual({
      allowed: false,
      retryAfterMs: 1,
    });
    expect(checkLogin(state, at + BASE_LOCKOUT_MS)).toEqual({ allowed: true });
  });

  it("lets one attempt through after a lockout, then locks for twice as long", () => {
    const five = failTimes(5);
    const retryAt = five.lastFailureAt + BASE_LOCKOUT_MS;
    expect(checkLogin(five, retryAt)).toEqual({ allowed: true });
    const six = recordFailure(five, retryAt);
    expect(checkLogin(six, retryAt)).toEqual({
      allowed: false,
      retryAfterMs: 2 * BASE_LOCKOUT_MS,
    });
  });

  it("never waits longer than the cap", () => {
    const state = failTimes(40);
    expect(checkLogin(state, state.lastFailureAt)).toEqual({
      allowed: false,
      retryAfterMs: MAX_LOCKOUT_MS,
    });
    expect(checkLogin(state, state.lastFailureAt + MAX_LOCKOUT_MS)).toEqual({
      allowed: true,
    });
  });

  it("holds across a restart: only the stored state and the clock matter", () => {
    const stored = JSON.parse(JSON.stringify(failTimes(7)));
    const state = parseThrottleState(stored);
    expect(checkLogin(state, state.lastFailureAt + 60_000)).toEqual({
      allowed: false,
      retryAfterMs: 60_000,
    });
  });

  it("clamps the wait when the clock has been set back", () => {
    const state: LoginThrottleState = {
      failures: 5,
      lastFailureAt: T0 + 86_400_000,
    };
    expect(checkLogin(state, T0)).toEqual({
      allowed: false,
      retryAfterMs: BASE_LOCKOUT_MS,
    });
  });

  it("is open again once the state is reset", () => {
    expect(checkLogin(failTimes(12), T0)).toMatchObject({ allowed: false });
    expect(checkLogin(NO_FAILURES, T0)).toEqual({ allowed: true });
  });
});

describe("recordFailure", () => {
  it("increments the count and stamps the time without mutating the input", () => {
    const before: LoginThrottleState = { failures: 2, lastFailureAt: T0 };
    expect(recordFailure(before, T0 + 5)).toEqual({
      failures: 3,
      lastFailureAt: T0 + 5,
    });
    expect(before).toEqual({ failures: 2, lastFailureAt: T0 });
  });
});

describe("parseThrottleState", () => {
  it("round-trips a stored state", () => {
    expect(parseThrottleState({ failures: 6, lastFailureAt: T0 })).toEqual({
      failures: 6,
      lastFailureAt: T0,
    });
  });

  it("treats a missing or malformed value as no failures", () => {
    for (const raw of [
      undefined,
      null,
      "5",
      7,
      [],
      {},
      { failures: "5", lastFailureAt: T0 },
      { failures: 2.5, lastFailureAt: T0 },
      { failures: -3, lastFailureAt: T0 },
      { failures: 5 },
      { failures: 5, lastFailureAt: null },
    ]) {
      expect(parseThrottleState(raw)).toEqual(NO_FAILURES);
    }
  });
});

describe("formatWait", () => {
  it("speaks seconds under a minute and minutes from there, rounding up", () => {
    expect(formatWait(1)).toBe("1 second");
    expect(formatWait(1_000)).toBe("1 second");
    expect(formatWait(29_001)).toBe("30 seconds");
    expect(formatWait(59_000)).toBe("59 seconds");
    expect(formatWait(60_000)).toBe("1 minute");
    expect(formatWait(61_000)).toBe("2 minutes");
    expect(formatWait(MAX_LOCKOUT_MS)).toBe("15 minutes");
  });
});
