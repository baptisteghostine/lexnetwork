import { describe, expect, it } from "vitest";

import { buildEnrichPrompt, hasEnrichMaterial, parseEnrichment, type EnrichInput } from "@/lib/ai/enrich";

// SPEC §11 enrichment: the prompt is only what Rolo captured, and the
// parsed card is bounded — strength clamped, facts and questions capped.

const DAY = 24 * 60 * 60 * 1000;
const base: EnrichInput = {
  displayName: "Sam Ford",
  title: "Associate",
  company: "Santander",
  location: "London",
  bio: "M&A | ex-Barclays",
  workHistory: [{ company: "Barclays", title: "Analyst", startDate: "2022-01", endDate: "2024-06", isCurrent: false }],
  education: [{ school: "LBS", degree: "MFA", field: null, endYear: 2026 }],
  tags: ["LBS"],
  groups: ["Banking"],
  customFields: [{ name: "Met at", value: "LBS welcome week" }],
  notes: ["wants intro to Priya"],
  exchanges: { total: 4, firstAt: 1_000, lastAt: 2_000, recent: ["You messaged — hi · 3d ago"] },
  changes: [{ field: "company", oldValue: "Barclays", newValue: "Santander", detectedAt: 2_000 }],
  now: 2_000 + 3 * DAY,
};

describe("buildEnrichPrompt", () => {
  it("includes every captured block", () => {
    const p = buildEnrichPrompt(base);
    for (const needle of [
      "Current: Associate at Santander",
      "Work history: Analyst at Barclays (2022-01–2024-06)",
      "Education: MFA, LBS, 2026",
      "Groups: Banking",
      "Fields: Met at: LBS welcome week",
      "Exchanges: 4 logged",
      "Detected changes: company Barclays → Santander (3d ago)",
      "- wants intro to Priya",
    ]) {
      expect(p).toContain(needle);
    }
  });

  it("says when there are no notes", () => {
    expect(buildEnrichPrompt({ ...base, notes: [] })).toContain("written no notes");
  });
});

describe("parseEnrichment", () => {
  it("clamps strength and caps lists", () => {
    const out = parseEnrichment(
      JSON.stringify({
        summary: "Sam is an LBS classmate who just moved to Santander after two years at Barclays.",
        facts: Array.from({ length: 12 }, (_, i) => ({ label: `L${i}`, value: `v${i}` })),
        relationship: { strength: 9, why: "frequent" },
        openQuestions: ["a", "b", "c", "d"],
      })
    );
    expect(out?.relationship.strength).toBe(5);
    expect(out?.facts).toHaveLength(10);
    expect(out?.openQuestions).toHaveLength(3);
  });

  it("rejects a summary that is too short to be a profile", () => {
    expect(parseEnrichment(JSON.stringify({ summary: "Sam.", facts: [], relationship: { strength: 3, why: "" }, openQuestions: [] }))).toBeNull();
  });
});

describe("hasEnrichMaterial", () => {
  it("is false for a bare name and true once anything is known", () => {
    const bare: EnrichInput = {
      ...base,
      title: null,
      company: null,
      bio: null,
      workHistory: [],
      education: [],
      notes: [],
      exchanges: { total: 0, firstAt: null, lastAt: null, recent: [] },
    };
    expect(hasEnrichMaterial(bare)).toBe(false);
    expect(hasEnrichMaterial({ ...bare, notes: ["x"] })).toBe(true);
  });
});
