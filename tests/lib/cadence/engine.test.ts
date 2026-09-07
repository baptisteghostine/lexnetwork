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
  it("+1m clamps to the end of shorter months", () => {
    const jan31 = new Date(2026, 0, 31, 12).getTime();
    const result = new Date(snoozeUntil("1m", jan31));
    expect(result.getMonth()).toBe(1); // Jan 31 + 1 month → Feb 28, not Mar 3
    expect(result.getDate()).toBe(28);
    const aug31 = new Date(2026, 7, 31, 12).getTime();
    const sep = new Date(snoozeUntil("1m", aug31));
    expect(sep.getMonth()).toBe(8);
    expect(sep.getDate()).toBe(30);
  });
});

describe("planSnoozeAll (SPEC §3 AC: 40 due, 5 starred, 21-day horizon)", () => {
  // A fixed Monday noon keeps weekday math stable. The engine defaults to
  // UTC when no timezone is passed, so the fixture and the assertions
  // below read the clock in UTC too — a machine in Zurich must see the
  // same plan as one in Reykjavik (the owner-timezone describe below
  // covers the non-UTC path explicitly).
  const NOW = Date.UTC(2026, 7, 10, 12, 0, 0); // Mon Aug 10 2026

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
      expect([0, 6]).not.toContain(d.getUTCDay());
      expect(d.getUTCHours()).toBe(8);
      const key = d.toISOString().slice(0, 10);
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

describe("planSnoozeAll — owner timezone", () => {
  // Mon 2026-08-10 12:00 UTC. In Pacific/Honolulu (UTC-10, no DST) that is
  // Mon 02:00 local.
  const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);
  const due = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1,
    starred: false,
    nextTouchAt: NOW - i * 1000,
  }));

  function localParts(tz: string, ms: number) {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      hour12: false,
    });
    const p: Record<string, string> = {};
    for (const part of dtf.formatToParts(ms)) p[part.type] = part.value;
    return { weekday: p.weekday, hour: Number(p.hour) % 24 };
  }

  it("assignments land on owner-local weekdays at the owner-local digest hour", () => {
    const plan = planSnoozeAll(due, { now: NOW, timezone: "Pacific/Honolulu" });
    for (const p of plan) {
      const local = localParts("Pacific/Honolulu", p.snoozedUntil);
      expect(["Mon", "Tue", "Wed", "Thu", "Fri"]).toContain(local.weekday);
      expect(local.hour).toBe(8);
      // In UTC these instants read 18:00 — a server-local plan would have
      // put them at 08:00 UTC = Sunday 22:00 in Honolulu.
    }
  });

  it("UTC default matches UTC wall clock", () => {
    const plan = planSnoozeAll(due, { now: NOW });
    for (const p of plan) {
      const d = new Date(p.snoozedUntil);
      expect([0, 6]).not.toContain(d.getUTCDay());
      expect(d.getUTCHours()).toBe(8);
    }
  });
});
