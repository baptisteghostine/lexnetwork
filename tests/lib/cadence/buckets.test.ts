import { describe, expect, it } from "vitest";

import {
  bucketFor,
  bucketId,
  CADENCE_PRESETS,
} from "@/lib/cadence/engine";

// SPEC §3a: the board must place every contact in exactly one column —
// a contact that falls through would make the Uncategorized count lie
// about how much triage is left.

const NOW = Date.UTC(2026, 7, 15, 12);

describe("bucketFor", () => {
  it("puts each preset cadence in its own column", () => {
    for (const preset of CADENCE_PRESETS) {
      const bucket = bucketFor({
        cadenceDays: preset.days,
        cadenceReviewedAt: NOW,
      });
      expect(bucket, preset.label).toEqual({ kind: "days", days: preset.days });
      expect(bucketId(bucket)).toBe(String(preset.days));
    }
  });

  it("a hand-typed cadence matching no preset lands in Custom, not a neighbour", () => {
    expect(bucketFor({ cadenceDays: 60, cadenceReviewedAt: NOW })).toEqual({
      kind: "custom",
    });
    // Adjacent to a preset but not equal — must not be rounded in.
    expect(bucketFor({ cadenceDays: 90, cadenceReviewedAt: NOW })).toEqual({
      kind: "custom",
    });
  });

  it("distinguishes never-triaged from deliberately-excluded", () => {
    expect(bucketFor({ cadenceDays: null, cadenceReviewedAt: null })).toEqual({
      kind: "unset",
    });
    expect(bucketFor({ cadenceDays: null, cadenceReviewedAt: NOW })).toEqual({
      kind: "never",
    });
  });

  it("a cadence outranks the review stamp — a reviewed contact with days is not 'never'", () => {
    expect(bucketFor({ cadenceDays: 7, cadenceReviewedAt: null })).toEqual({
      kind: "days",
      days: 7,
    });
  });

  it("every bucket has a distinct stable id", () => {
    const ids = [
      ...CADENCE_PRESETS.map((p) =>
        bucketId(bucketFor({ cadenceDays: p.days, cadenceReviewedAt: NOW }))
      ),
      bucketId(bucketFor({ cadenceDays: 60, cadenceReviewedAt: NOW })),
      bucketId(bucketFor({ cadenceDays: null, cadenceReviewedAt: null })),
      bucketId(bucketFor({ cadenceDays: null, cadenceReviewedAt: NOW })),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("CADENCE_PRESETS", () => {
  it("is sorted by ascending frequency so the board reads left to right", () => {
    const days = CADENCE_PRESETS.map((p) => p.days);
    expect([...days].sort((a, b) => a - b)).toEqual(days);
  });

  it("keeps the day counts that pre-board cadences were stored with", () => {
    // Changing 91→90 or 182→180 would strand existing contacts in Custom.
    const days = CADENCE_PRESETS.map((p) => p.days);
    for (const legacy of [7, 30, 91, 182, 365]) {
      expect(days, `legacy cadence ${legacy}`).toContain(legacy);
    }
  });
});
