import { describe, expect, it } from "vitest";

import {
  buildTimelineAppendix,
  NEED_MORE_MAX,
  parseNeedMore,
  PLAN_FILTERS_MAX,
  validateAskPlan,
} from "@/lib/ai/ask-plan";

// SPEC §11 iterative Ask: the plan's filters go through the same
// validator as NL search (an invented tag id drops that filter set, not
// the plan), searches are capped, and a needMore round may only name
// people the model was shown.

const catalog = { tags: [{ id: 1, name: "LBS" }], groups: [], customFields: [] };

describe("validateAskPlan", () => {
  it("keeps valid filter sets, drops invalid ones, dedupes and caps searches", () => {
    const plan = validateAskPlan(
      {
        filters: [
          { v: 1, clauses: [{ dim: "company", mode: "current", value: "Evercore" }] },
          { v: 1, clauses: [{ dim: "tag", ids: [99] }] },
          { v: 1, clauses: [{ dim: "tag", ids: [1] }] },
          { v: 1, clauses: [{ dim: "starred", value: true }] },
        ],
        searches: [" Evercore ", "Evercore", "x", "ab", "cd", "ef"],
        noteSearches: [],
        needTimeline: true,
      },
      catalog
    );
    expect(plan).not.toBeNull();
    expect(plan!.filters).toHaveLength(PLAN_FILTERS_MAX);
    expect(plan!.filters[0].clauses[0]).toMatchObject({ dim: "company", value: "Evercore" });
    expect(plan!.filters[1].clauses[0]).toMatchObject({ dim: "tag", ids: [1] });
    expect(plan!.searches).toEqual(["Evercore", "ab", "cd"]);
    expect(plan!.needTimeline).toBe(true);
  });

  it("fails closed on a malformed plan", () => {
    expect(validateAskPlan({ filters: "no" }, catalog)).toBeNull();
    expect(validateAskPlan(null, catalog)).toBeNull();
  });
});

describe("parseNeedMore", () => {
  it("returns only allowed ids, capped, or null", () => {
    const allowed = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseNeedMore({ needMore: { contactIds: [3, 3, 42, 1] } }, allowed)).toEqual([3, 1]);
    expect(parseNeedMore({ needMore: { contactIds: [1, 2, 3, 4, 5, 6, 7, 8] } }, allowed)).toHaveLength(NEED_MORE_MAX);
    expect(parseNeedMore({ needMore: { contactIds: [42] } }, allowed)).toBeNull();
    expect(parseNeedMore({ summary: "x", picks: [] }, allowed)).toBeNull();
  });
});

describe("buildTimelineAppendix", () => {
  it("writes one section per contact and says when there is nothing", () => {
    const text = buildTimelineAppendix([
      { contactId: 2, name: "Ana", interactions: ["You messaged — hi · 2d ago"], notes: [] },
    ]);
    expect(text).toContain("## #2 Ana");
    expect(text).toContain("- You messaged — hi · 2d ago");
    expect(text).toContain("No notes.");
  });
});
