// "Worth reconnecting" (SPEC §3, owner request 2026-09-04): a few people a
// day from the un-cadenced long tail — real history, no cadence, drifted.
// Pure: the picker in server/resurface.ts feeds it rows and a clock.
//
// The cadence engine only ever surfaces people the owner has put on a
// cadence. Everyone else — the 2,000 LinkedIn connections, the person
// you emailed weekly two years ago and then didn't — is invisible to it.
// This is the nudge for them, deliberately small (3 a day) and rotating
// (a cooldown after each showing), so it reads as a suggestion and never
// as a second queue.

import { DAY_MS } from "@/lib/cadence/engine";

export const DEFAULT_PER_DAY = 3;
export const MAX_PER_DAY = 10;
/** Minimum silence before someone is "drifted", not just "quiet". */
export const MIN_SILENCE_DAYS = 120;
/** After a showing (or a "not now"), how long before they can come round. */
export const COOLDOWN_DAYS = 90;
/** How many counting interactions make it a relationship, not a one-off. */
export const MIN_INTERACTIONS = 2;

export function clampResurfacePerDay(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PER_DAY;
  return Math.min(MAX_PER_DAY, Math.max(1, Math.floor(value)));
}

export type ResurfaceCandidate = {
  id: number;
  starred: boolean;
  archivedAt: number | null;
  cadenceDays: number | null;
  /** Set = the owner made a deliberate keep-in-touch decision (SPEC §3a). */
  cadenceReviewedAt: number | null;
  lastInteractionAt: number | null;
  /** Counting interactions, all time. */
  interactionCount: number;
  hasOpenChange: boolean;
  resurfacedAt: number | null;
  resurfaceDismissedAt: number | null;
};

export function isEligible(c: ResurfaceCandidate, now: number): boolean {
  if (c.archivedAt !== null) return false;
  // On a cadence, or deliberately taken off one — the owner has decided.
  if (c.cadenceDays !== null || c.cadenceReviewedAt !== null) return false;
  if (c.lastInteractionAt === null) return false;
  if (c.interactionCount < MIN_INTERACTIONS) return false;
  if (now - c.lastInteractionAt < MIN_SILENCE_DAYS * DAY_MS) return false;
  const lastShown = Math.max(c.resurfacedAt ?? 0, c.resurfaceDismissedAt ?? 0);
  if (lastShown > 0 && now - lastShown < COOLDOWN_DAYS * DAY_MS) return false;
  return true;
}

/**
 * Higher = more worth it. Depth of history dominates; a star and an open
 * job change add; recency prefers the 4–18-month band (drifted, not
 * gone) over both last month and five years ago.
 */
export function score(c: ResurfaceCandidate, now: number): number {
  const depth = Math.log1p(c.interactionCount) * 2;
  const star = c.starred ? 3 : 0;
  const change = c.hasOpenChange ? 2 : 0;
  const months = (now - (c.lastInteractionAt ?? now)) / (30 * DAY_MS);
  const recency = Math.max(0, 1 - Math.abs(months - 9) / 24) * 2;
  return depth + star + change + recency;
}

/** The day's picks: eligible, best first, stable on ties. */
export function pickResurface(
  candidates: ResurfaceCandidate[],
  now: number,
  perDay: number
): ResurfaceCandidate[] {
  return candidates
    .filter((c) => isEligible(c, now))
    .map((c) => ({ c, s: score(c, now) }))
    .sort((a, b) => b.s - a.s || a.c.id - b.c.id)
    .slice(0, clampResurfacePerDay(perDay))
    .map((x) => x.c);
}
