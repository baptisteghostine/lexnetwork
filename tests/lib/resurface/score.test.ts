import { describe, expect, it } from "vitest";

import { DAY_MS } from "@/lib/cadence/engine";
import {
  clampResurfacePerDay,
  isEligible,
  pickResurface,
  score,
  type ResurfaceCandidate,
} from "@/lib/resurface/score";

const NOW = Date.UTC(2026, 8, 4);
const D = DAY_MS;

function c(over: Partial<ResurfaceCandidate>): ResurfaceCandidate {
  return {
    id: 1,
    starred: false,
    archivedAt: null,
    cadenceDays: null,
    cadenceReviewedAt: null,
    lastInteractionAt: NOW - 270 * D, // 9 months: the sweet spot
    interactionCount: 8,
    hasOpenChange: false,
    resurfacedAt: null,
    resurfaceDismissedAt: null,
    ...over,
  };
}

describe("isEligible", () => {
  it("wants no cadence decision, real history, and real silence", () => {
    expect(isEligible(c({}), NOW)).toBe(true);
    expect(isEligible(c({ cadenceDays: 30 }), NOW)).toBe(false);
    expect(isEligible(c({ cadenceReviewedAt: NOW - D }), NOW)).toBe(false);
    expect(isEligible(c({ archivedAt: NOW }), NOW)).toBe(false);
    expect(isEligible(c({ lastInteractionAt: null }), NOW)).toBe(false);
    expect(isEligible(c({ interactionCount: 1 }), NOW)).toBe(false);
    expect(isEligible(c({ lastInteractionAt: NOW - 30 * D }), NOW)).toBe(false);
  });

  it("honours the cooldown after a showing or a dismissal", () => {
    expect(isEligible(c({ resurfacedAt: NOW - 10 * D }), NOW)).toBe(false);
    expect(isEligible(c({ resurfaceDismissedAt: NOW - 10 * D }), NOW)).toBe(false);
    expect(isEligible(c({ resurfacedAt: NOW - 100 * D }), NOW)).toBe(true);
  });
});

describe("score", () => {
  it("prefers depth, stars, open changes, and the drifted band", () => {
    const base = score(c({}), NOW);
    expect(score(c({ interactionCount: 40 }), NOW)).toBeGreaterThan(base);
    expect(score(c({ starred: true }), NOW)).toBeGreaterThan(base);
    expect(score(c({ hasOpenChange: true }), NOW)).toBeGreaterThan(base);
    // Five years of silence scores below nine months, all else equal.
    expect(score(c({ lastInteractionAt: NOW - 5 * 365 * D }), NOW)).toBeLessThan(base);
  });
});

describe("pickResurface", () => {
  it("returns the best eligible, capped, stable on ties", () => {
    const picks = pickResurface(
      [
        c({ id: 5 }),
        c({ id: 3 }), // tie with 5 → lower id first
        c({ id: 9, starred: true }),
        c({ id: 2, cadenceDays: 7 }), // ineligible
        c({ id: 7, interactionCount: 30 }),
      ],
      NOW,
      3
    );
    // A star outweighs 30-vs-8 interactions; depth still beats the tie.
    expect(picks.map((p) => p.id)).toEqual([9, 7, 3]);
  });

  it("is deterministic across calls", () => {
    const pool = [c({ id: 1 }), c({ id: 2 }), c({ id: 3 })];
    expect(pickResurface(pool, NOW, 2)).toEqual(pickResurface([...pool].reverse(), NOW, 2));
  });
});

describe("clampResurfacePerDay", () => {
  it("defaults to 3 and stays within 1–10", () => {
    expect(clampResurfacePerDay(undefined)).toBe(3);
    expect(clampResurfacePerDay(0)).toBe(1);
    expect(clampResurfacePerDay(50)).toBe(10);
  });
});
