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

describe("nextOccurrence — owner timezone (the UTC-fields trap)", () => {
  it("weekly Tuesday 8pm EST stays on local Tuesdays", () => {
    // Tue 2026-01-13 20:00 America/New_York = Wed 2026-01-14 01:00 UTC.
    const dtstart = Date.UTC(2026, 0, 14, 1, 0);
    const next = nextOccurrence(
      "FREQ=WEEKLY;BYDAY=TU",
      dtstart,
      dtstart,
      "America/New_York"
    );
    // Next local Tuesday 8pm: Tue Jan 20 20:00 EST = Wed Jan 21 01:00 UTC.
    expect(next).toBe(Date.UTC(2026, 0, 21, 1, 0));
    // Without the timezone the same rule lands on UTC-Tuesdays — i.e.
    // local *Mondays* — which is exactly the bug this pins.
    expect(nextOccurrence("FREQ=WEEKLY;BYDAY=TU", dtstart, dtstart)).toBe(
      Date.UTC(2026, 0, 20, 1, 0)
    );
  });

  it("BYMONTHDAY=1 at 00:30 local for a UTC+2 owner fires on the 1st, not the 2nd", () => {
    // 2026-06-01 00:30 Europe/Athens (UTC+3 in summer) = 2026-05-31 21:30 UTC.
    const dtstart = Date.UTC(2026, 4, 31, 21, 30);
    const next = nextOccurrence(
      "FREQ=MONTHLY;BYMONTHDAY=1",
      dtstart,
      dtstart,
      "Europe/Athens"
    );
    // Next: 2026-07-01 00:30 local = 2026-06-30 21:30 UTC.
    expect(next).toBe(Date.UTC(2026, 5, 30, 21, 30));
  });

  it("occurrences keep local wall time across a DST transition", () => {
    // Weekly Tuesday 9:00 Europe/London starting Tue 2026-03-24 (GMT, UTC+0).
    const dtstart = Date.UTC(2026, 2, 24, 9, 0);
    // DST starts Sun 2026-03-29; next Tuesday is Mar 31 (BST, UTC+1):
    // 9:00 local = 8:00 UTC.
    const next = nextOccurrence(
      "FREQ=WEEKLY;BYDAY=TU",
      dtstart,
      dtstart,
      "Europe/London"
    );
    expect(next).toBe(Date.UTC(2026, 2, 31, 8, 0));
  });
});
