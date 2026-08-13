import { describe, expect, it } from "vitest";

import {
  computeNextTouchAt,
  DAY_MS,
  interactionCountsForTouch,
  planSnoozeAll,
  snoozeUntil,
  type DueContact,
} from "@/lib/cadence/engine";

const JAN_1 = Date.UTC(2026, 0, 1);
const JAN_20 = Date.UTC(2026, 0, 20);
const JAN_31 = Date.UTC(2026, 0, 31);
const FEB_19 = Date.UTC(2026, 1, 19);
const FEB_25 = Date.UTC(2026, 1, 25);
const MAR_22 = Date.UTC(2026, 2, 22);

describe("computeNextTouchAt (SPEC §3 ACs)", () => {
  it("cadence 30, last interaction Jan 1 → due Jan 31", () => {
    expect(
      computeNextTouchAt({
        cadenceDays: 30,
        cadenceAssignedAt: JAN_1,
        lastInteractionAt: JAN_1,
        snoozedUntil: null,
      })
    ).toBe(JAN_31);
  });

  it("logging an interaction Jan 20 moves it to Feb 19", () => {
    expect(
      computeNextTouchAt({
        cadenceDays: 30,
        cadenceAssignedAt: JAN_1,
        lastInteractionAt: JAN_20,
        snoozedUntil: null,
      })
    ).toBe(FEB_19);
  });

  it("snooze past the computed date wins; earlier snooze does not", () => {
    const base = {
      cadenceDays: 30,
      cadenceAssignedAt: JAN_1,
      lastInteractionAt: JAN_20, // computed Feb 19
    };
    expect(computeNextTouchAt({ ...base, snoozedUntil: FEB_25 })).toBe(FEB_25);
    expect(computeNextTouchAt({ ...base, snoozedUntil: JAN_31 })).toBe(FEB_19);
  });

  it("after snooze clears on a Feb 20 interaction, due Mar 22", () => {
    expect(
      computeNextTouchAt({
        cadenceDays: 30,
        cadenceAssignedAt: JAN_1,
        lastInteractionAt: Date.UTC(2026, 1, 20),
        snoozedUntil: null, // cleared by the counting interaction
      })
    ).toBe(MAR_22);
  });

  it("no interactions yet → due one interval after cadence assignment", () => {
    expect(
      computeNextTouchAt({
        cadenceDays: 7,
        cadenceAssignedAt: JAN_1,
        lastInteractionAt: null,
        snoozedUntil: null,
      })
    ).toBe(JAN_1 + 7 * DAY_MS);
  });

  it("no cadence → null", () => {
    expect(
      computeNextTouchAt({
        cadenceDays: null,
        cadenceAssignedAt: null,
        lastInteractionAt: JAN_1,
        snoozedUntil: FEB_25,
      })
    ).toBeNull();
  });
});

describe("interactionCountsForTouch (owner-confirmed rules)", () => {
  it("outbound email counts, inbound does not", () => {
    expect(interactionCountsForTouch("email", "outbound")).toBe(true);
    expect(interactionCountsForTouch("email", "inbound")).toBe(false);
    expect(interactionCountsForTouch("email", null)).toBe(false);
  });
  it("meetings, messages, manual logs count; reminders never", () => {
    expect(interactionCountsForTouch("meeting", null)).toBe(true);
    expect(interactionCountsForTouch("message", "inbound")).toBe(true);
    expect(interactionCountsForTouch("manual", null)).toBe(true);
    expect(interactionCountsForTouch("reminder_fired", null)).toBe(false);
  });
});

describe("snoozeUntil", () => {
  it("computes day-based presets exactly", () => {
    expect(snoozeUntil("1d", JAN_1)).toBe(JAN_1 + DAY_MS);
    expect(snoozeUntil("3d", JAN_1)).toBe(JAN_1 + 3 * DAY_MS);
    expect(snoozeUntil("1w", JAN_1)).toBe(JAN_1 + 7 * DAY_MS);
  });
  it("+1m is calendar-aware", () => {
    const jan31 = new Date(2026, 0, 31, 12).getTime();
    const result = new Date(snoozeUntil("1m", jan31));
    expect(result.getMonth()).toBe(2); // Jan 31 + 1 month → Mar 3 (JS rollover)
  });
});

describe("planSnoozeAll (SPEC §3 AC: 40 due, 5 starred, 21-day horizon)", () => {
  // A fixed Monday noon local time keeps weekday math stable.
  const NOW = new Date(2026, 7, 10, 12, 0, 0).getTime(); // Mon Aug 10 2026

  const due: DueContact[] = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    starred: i < 5,
    nextTouchAt: NOW - (40 - i) * DAY_MS, // id 1 most overdue
  }));

  it("is deterministic", () => {
    const a = planSnoozeAll(due, { now: NOW });
    const b = planSnoozeAll([...due].reverse(), { now: NOW });
    expect(a).toEqual(b);
  });

  it("never lands on a weekend and respects the per-day cap", () => {
    const plan = planSnoozeAll(due, { now: NOW });
    expect(plan).toHaveLength(40);
    const perDay = new Map<string, number>();
    for (const p of plan) {
      const d = new Date(p.snoozedUntil);
      expect([0, 6]).not.toContain(d.getDay());
      expect(d.getHours()).toBe(8);
      const key = d.toDateString();
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
    // 15 weekdays in 21 days → cap = max(3, ceil(40/15)) = 3
    for (const n of perDay.values()) expect(n).toBeLessThanOrEqual(3);
  });

  it("starred contacts land earliest", () => {
    const plan = planSnoozeAll(due, { now: NOW });
    const byId = new Map(plan.map((p) => [p.contactId, p.snoozedUntil]));
    const latestStarred = Math.max(...[1, 2, 3, 4, 5].map((id) => byId.get(id)!));
    const earliestUnstarred = Math.min(
      ...due.filter((d) => !d.starred).map((d) => byId.get(d.id)!)
    );
    expect(latestStarred).toBeLessThanOrEqual(earliestUnstarred);
  });

  it("grows the cap when the horizon can't fit everyone at the floor", () => {
    const many: DueContact[] = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      starred: false,
      nextTouchAt: NOW - i,
    }));
    const plan = planSnoozeAll(many, { now: NOW });
    expect(plan).toHaveLength(100);
    const horizonEnd = NOW + 22 * DAY_MS;
    for (const p of plan) expect(p.snoozedUntil).toBeLessThan(horizonEnd);
  });

  it("second run after applying is a no-op (nothing due anymore)", () => {
    expect(planSnoozeAll([], { now: NOW })).toEqual([]);
  });
});
