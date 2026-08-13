import { describe, expect, it } from "vitest";

import {
  localDateKey,
  localParts,
  nextLocalHour,
  tzOffsetMs,
} from "@/lib/time";

describe("tzOffsetMs", () => {
  it("is zero for UTC", () => {
    expect(tzOffsetMs("UTC", Date.UTC(2026, 5, 1, 12))).toBe(0);
  });

  it("knows standard vs daylight offsets for New York", () => {
    expect(tzOffsetMs("America/New_York", Date.UTC(2026, 0, 15, 12))).toBe(
      -5 * 3_600_000
    );
    expect(tzOffsetMs("America/New_York", Date.UTC(2026, 6, 15, 12))).toBe(
      -4 * 3_600_000
    );
  });
});

describe("nextLocalHour", () => {
  it("returns the next 8:00 in UTC", () => {
    const after = Date.UTC(2026, 7, 13, 9, 30); // 09:30 → tomorrow 08:00
    expect(nextLocalHour("UTC", 8, after)).toBe(Date.UTC(2026, 7, 14, 8));
  });

  it("returns today's hour when it is still ahead", () => {
    const after = Date.UTC(2026, 7, 13, 5);
    expect(nextLocalHour("UTC", 8, after)).toBe(Date.UTC(2026, 7, 13, 8));
  });

  it("crosses a spring-forward DST boundary correctly (SPEC §3 DST)", () => {
    // US DST 2026 starts Sun Mar 8. From Sat 15:00 EST, the next local
    // 08:00 is Sunday 08:00 EDT = 12:00 UTC (not 13:00).
    const after = Date.UTC(2026, 2, 7, 20);
    const next = nextLocalHour("America/New_York", 8, after);
    expect(next).toBe(Date.UTC(2026, 2, 8, 12));
    expect(localParts("America/New_York", next).hour).toBe(8);
  });

  it("is strictly after the reference time", () => {
    const at8 = Date.UTC(2026, 7, 13, 8);
    expect(nextLocalHour("UTC", 8, at8)).toBe(Date.UTC(2026, 7, 14, 8));
  });
});

describe("localDateKey", () => {
  it("uses the local calendar date, not UTC's", () => {
    // 03:00 UTC on Jun 2 is still Jun 1 in New York.
    const epoch = Date.UTC(2026, 5, 2, 3);
    expect(localDateKey("America/New_York", epoch)).toBe("2026-06-01");
    expect(localDateKey("UTC", epoch)).toBe("2026-06-02");
  });
});
