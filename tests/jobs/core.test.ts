import { describe, expect, it } from "vitest";

import {
  applyOutcome,
  backoffDelayMs,
  LEASE_MS,
  reclaimDecision,
} from "@/jobs/core";

describe("backoffDelayMs", () => {
  it("doubles per attempt from a 30s base (SCHEMA.md)", () => {
    expect(backoffDelayMs(1)).toBe(60_000);
    expect(backoffDelayMs(2)).toBe(120_000);
    expect(backoffDelayMs(3)).toBe(240_000);
    expect(backoffDelayMs(4)).toBe(480_000);
  });
});

describe("applyOutcome", () => {
  const now = 1_000_000;

  it("success finishes the job", () => {
    expect(applyOutcome({ attempts: 1, maxAttempts: 5 }, null, now)).toEqual({
      status: "success",
      finishedAt: now,
    });
  });

  it("failure with attempts left re-schedules with backoff", () => {
    const out = applyOutcome({ attempts: 2, maxAttempts: 5 }, "boom", now);
    expect(out).toEqual({
      status: "pending",
      runAt: now + backoffDelayMs(2),
      lastError: "boom",
    });
  });

  it("failure on the final attempt goes dead", () => {
    const out = applyOutcome({ attempts: 5, maxAttempts: 5 }, "boom", now);
    expect(out.status).toBe("dead");
  });
});

describe("reclaimDecision", () => {
  const base = { id: 1, attempts: 1, maxAttempts: 5 };

  it("leaves non-running rows alone", () => {
    expect(
      reclaimDecision({ ...base, status: "pending", startedAt: null }, 10)
    ).toBe("keep");
  });

  it("keeps running rows inside the lease window", () => {
    expect(
      reclaimDecision(
        { ...base, status: "running", startedAt: 1000 },
        1000 + LEASE_MS - 1
      )
    ).toBe("keep");
  });

  it("re-pends running rows past the lease (crash recovery)", () => {
    expect(
      reclaimDecision(
        { ...base, status: "running", startedAt: 1000 },
        1000 + LEASE_MS + 1
      )
    ).toBe("pending");
  });

  it("kills crashed rows that were on their last attempt", () => {
    expect(
      reclaimDecision(
        { ...base, attempts: 5, status: "running", startedAt: 1000 },
        1000 + LEASE_MS + 1
      )
    ).toBe("dead");
  });
});
