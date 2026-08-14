// The keep-in-touch engine (SPEC §3). Pure functions — every DB write path
// funnels through recompute.ts, which calls into here.

import { fromFakeUtc, toFakeUtc } from "@/lib/time";

export const DAY_MS = 24 * 60 * 60 * 1000;

export const CADENCE_PRESETS = [
  { label: "Weekly", days: 7 },
  { label: "Monthly", days: 30 },
  { label: "Quarterly", days: 91 },
  { label: "Biannual", days: 182 },
  { label: "Yearly", days: 365 },
] as const;

export type CadenceState = {
  cadenceDays: number | null;
  cadenceAssignedAt: number | null;
  lastInteractionAt: number | null;
  snoozedUntil: number | null;
};

/**
 * next_touch_at = max(base + cadence, snoozed_until); base is the last
 * counting interaction, or when none exists yet, the moment the cadence was
 * assigned (so a fresh cadence is due one full interval out, not instantly).
 */
export function computeNextTouchAt(s: CadenceState): number | null {
  if (s.cadenceDays === null) return null;
  const base = s.lastInteractionAt ?? s.cadenceAssignedAt;
  if (base === null) return null;
  const computed = base + s.cadenceDays * DAY_MS;
  return s.snoozedUntil !== null && s.snoozedUntil > computed
    ? s.snoozedUntil
    : computed;
}

/**
 * Which interactions reset the clock (SPEC §3, owner-confirmed): outbound
 * email counts, inbound-only does not — someone emailing you is not you
 * keeping in touch. Notes carry their own counts_for_touch flag instead.
 */
export function interactionCountsForTouch(
  kind: string,
  direction: string | null
): boolean {
  switch (kind) {
    case "manual":
    case "meeting":
    case "message":
      return true;
    case "email":
      return direction === "outbound";
    default:
      return false; // reminder_fired and anything unknown
  }
}

export type SnoozePreset = "1d" | "3d" | "1w" | "1m";

export function snoozeUntil(preset: SnoozePreset, now: number): number {
  switch (preset) {
    case "1d":
      return now + DAY_MS;
    case "3d":
      return now + 3 * DAY_MS;
    case "1w":
      return now + 7 * DAY_MS;
    case "1m": {
      // Calendar month with day clamping: Jan 31 + 1m = end of February,
      // not March 3 (raw setMonth overflows short months).
      const d = new Date(now);
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, lastDay));
      return d.getTime();
    }
  }
}

// ---------- snooze-all redistribution (SPEC §3, owner-confirmed defaults) ----------

export type SnoozeAllOptions = {
  now: number;
  /** Calendar days to spread over. Default 21. */
  horizonDays?: number;
  /** Minimum per-day capacity before the cap formula grows it. Default 3. */
  perDayFloor?: number;
  /** Local hour assignments land on (the digest hour). Default 8. */
  digestHour?: number;
  /**
   * IANA timezone the weekday/hour math runs in (SPEC §3: owner-local, like
   * every day-boundary rule). Defaults to UTC — callers must pass the
   * owner's zone or a UTC-offset owner gets weekend/off-hour assignments.
   */
  timezone?: string;
};

export type DueContact = {
  id: number;
  starred: boolean;
  nextTouchAt: number;
};

/**
 * Deterministically spreads all currently-due contacts across upcoming
 * weekdays: starred first, then most-overdue first; per-day cap
 * max(floor, ceil(count / weekdaysInHorizon)) so everything fits in the
 * horizon; weekends get nothing.
 */
export function planSnoozeAll(
  due: DueContact[],
  opts: SnoozeAllOptions
): { contactId: number; snoozedUntil: number }[] {
  const horizonDays = opts.horizonDays ?? 21;
  const perDayFloor = opts.perDayFloor ?? 3;
  const digestHour = opts.digestHour ?? 8;

  if (due.length === 0) return [];

  const sorted = [...due].sort((a, b) => {
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    if (a.nextTouchAt !== b.nextTouchAt) return a.nextTouchAt - b.nextTouchAt;
    return a.id - b.id; // total order → deterministic
  });

  // Weekdays (Mon–Fri) starting tomorrow, in the owner's timezone, at the
  // digest hour. Work in "fake UTC" (UTC fields = owner wall clock) so the
  // weekday test and hour are the owner's, then map each slot back to a
  // real instant — offsets are re-resolved per slot, so DST inside the
  // horizon lands each assignment at the right local hour.
  const tz = opts.timezone ?? "UTC";
  const slots: number[] = [];
  const cursor = new Date(toFakeUtc(tz, opts.now));
  cursor.setUTCHours(digestHour, 0, 0, 0);
  for (let i = 1; i <= horizonDays; i++) {
    const day = new Date(cursor);
    day.setUTCDate(day.getUTCDate() + i);
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    slots.push(fromFakeUtc(tz, day.getTime()));
  }
  if (slots.length === 0) return []; // degenerate horizon

  const cap = Math.max(perDayFloor, Math.ceil(sorted.length / slots.length));

  const out: { contactId: number; snoozedUntil: number }[] = [];
  let slot = 0;
  let inSlot = 0;
  for (const c of sorted) {
    if (inSlot >= cap && slot < slots.length - 1) {
      slot++;
      inSlot = 0;
    }
    out.push({ contactId: c.id, snoozedUntil: slots[slot] });
    inSlot++;
  }
  return out;
}
