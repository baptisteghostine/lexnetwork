import { describe, expect, it } from "vitest";

import {
  buildAskPrompt,
  MAX_PICKS,
  validateAskAnswer,
  type AskCandidate,
} from "@/lib/ai/ask";

// SPEC §11 Ask: the model may only recommend people it was shown —
// invented ids are rejected (and trigger the retry), duplicates collapse,
// picks are capped.

const ALLOWED = new Set([1, 2, 3]);

describe("validateAskAnswer", () => {
  it("accepts grounded picks and trims", () => {
    const result = validateAskAnswer(
      {
        summary: "  Two people fit.  ",
        picks: [
          { contactId: 2, reason: " She ran fintech partnerships at Visa. " },
          { contactId: 1, reason: "Angel who writes first checks." },
        ],
      },
      ALLOWED
    );
    expect(result).toEqual({
      ok: true,
      answer: {
        summary: "Two people fit.",
        picks: [
          { contactId: 2, reason: "She ran fintech partnerships at Visa." },
          { contactId: 1, reason: "Angel who writes first checks." },
        ],
      },
    });
  });

  it("rejects an invented contact id by name", () => {
    const result = validateAskAnswer(
      { summary: "s", picks: [{ contactId: 99, reason: "made up" }] },
      ALLOWED
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("99");
      expect(result.errors.join(" ")).toContain("not in the candidate list");
    }
  });

  it("collapses duplicate picks and caps at MAX_PICKS", () => {
    const allowed = new Set(Array.from({ length: 20 }, (_, i) => i + 1));
    const picks = [
      { contactId: 1, reason: "r" },
      { contactId: 1, reason: "again" },
      ...Array.from({ length: 15 }, (_, i) => ({
        contactId: i + 2,
        reason: "r",
      })),
    ];
    const result = validateAskAnswer({ summary: "s", picks }, allowed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answer.picks).toHaveLength(MAX_PICKS);
      expect(new Set(result.answer.picks.map((p) => p.contactId)).size).toBe(
        MAX_PICKS
      );
    }
  });

  it("a pick without a reason is an error, not silently kept", () => {
    const result = validateAskAnswer(
      { summary: "s", picks: [{ contactId: 1, reason: "" }] },
      ALLOWED
    );
    expect(result.ok).toBe(false);
  });

  it("non-object and missing-fields shapes fail closed", () => {
    expect(validateAskAnswer("nope", ALLOWED).ok).toBe(false);
    expect(validateAskAnswer({ picks: [] }, ALLOWED).ok).toBe(false);
    expect(validateAskAnswer({ summary: "s" }, ALLOWED).ok).toBe(false);
  });
});

describe("buildAskPrompt", () => {
  it("lists every candidate with id, warmth, and history", () => {
    const candidates: AskCandidate[] = [
      {
        id: 7,
        name: "Ana Silva",
        title: "Partner",
        company: "Meridian",
        location: "Zurich, Switzerland",
        tags: ["investor"],
        lastContactDays: 12,
        history: ["Principal @ Alpine (2019–2022)"],
        starred: true,
      },
      {
        id: 9,
        name: "Kenji W.",
        title: null,
        company: null,
        location: null,
        tags: [],
        lastContactDays: null,
        history: [],
        starred: false,
      },
    ];
    const prompt = buildAskPrompt("who can intro me to fintech VCs?", candidates);
    expect(prompt).toContain("Question: who can intro me to fintech VCs?");
    expect(prompt).toContain("#7 Ana Silva — Partner @ Meridian");
    expect(prompt).toContain("last contact 12d ago");
    expect(prompt).toContain("Principal @ Alpine (2019–2022)");
    expect(prompt).toContain("starred");
    expect(prompt).toContain("#9 Kenji W. — no title on file");
    expect(prompt).toContain("never spoken");
  });
});
