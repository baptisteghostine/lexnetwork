import { describe, expect, it } from "vitest";

import { nextOccurrence, sanitizeRrule } from "@/lib/reminders/engine";

describe("sanitizeRrule", () => {
  it("accepts the SPEC §4 subset and normalizes case/prefix", () => {
    expect(sanitizeRrule("rrule:freq=monthly;byday=2tu")).toBe(
      "FREQ=MONTHLY;BYDAY=2TU"
    );
    expect(sanitizeRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR")).toBe(
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR"
    );
    expect(sanitizeRrule("FREQ=YEARLY;BYMONTHDAY=15")).toBe(
      "FREQ=YEARLY;BYMONTHDAY=15"
    );
  });

  it("rejects frequencies and keys outside the subset", () => {
    expect(sanitizeRrule("FREQ=HOURLY")).toBeNull();
    expect(sanitizeRrule("FREQ=MONTHLY;BYSETPOS=2")).toBeNull();
    expect(sanitizeRrule("INTERVAL=2")).toBeNull(); // no FREQ
    expect(sanitizeRrule("")).toBeNull();
    expect(sanitizeRrule("garbage")).toBeNull();
  });
});

describe("nextOccurrence", () => {
  it("fires 'every 2nd Tuesday monthly' on the right dates across 6 occurrences (SPEC §4 AC)", () => {
    const dtstart = Date.UTC(2026, 0, 13, 9); // Tue Jan 13 2026 — a 2nd Tuesday
    const rule = "FREQ=MONTHLY;BYDAY=2TU";
    const expected = [
      Date.UTC(2026, 1, 10, 9), // Feb 10
      Date.UTC(2026, 2, 10, 9), // Mar 10
      Date.UTC(2026, 3, 14, 9), // Apr 14
      Date.UTC(2026, 4, 12, 9), // May 12
      Date.UTC(2026, 5, 9, 9), //  Jun 9
      Date.UTC(2026, 6, 14, 9), // Jul 14
    ];
    let cursor = dtstart;
    for (const want of expected) {
      const next = nextOccurrence(rule, dtstart, cursor);
      expect(next).toBe(want);
      cursor = next as number;
    }
  });

  it("includes dtstart itself when it is still ahead", () => {
    const dtstart = Date.UTC(2026, 3, 1, 8);
    expect(nextOccurrence("FREQ=DAILY", dtstart, dtstart - 1000)).toBe(dtstart);
  });

  it("exhausts COUNT", () => {
    const dtstart = Date.UTC(2026, 0, 1, 8);
    const rule = "FREQ=DAILY;COUNT=3";
    const second = nextOccurrence(rule, dtstart, dtstart);
    const third = nextOccurrence(rule, dtstart, second as number);
    expect(third).toBe(Date.UTC(2026, 0, 3, 8));
    expect(nextOccurrence(rule, dtstart, third as number)).toBeNull();
  });

  it("returns null once UNTIL has passed (series auto-completes)", () => {
    const dtstart = Date.UTC(2026, 0, 1, 8);
    const rule = "FREQ=WEEKLY;UNTIL=20260115T000000Z";
    expect(
      nextOccurrence(rule, dtstart, Date.UTC(2026, 0, 20))
    ).toBeNull();
  });
});
