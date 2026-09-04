import { describe, expect, it } from "vitest";

import {
  buildAutoTagSystem,
  buildMeetingPrepPrompt,
  parseOpeners,
  parseTagSuggestions,
  parseTalkingPoints,
  type AutoTagContact,
} from "@/lib/ai/prompts";

const CONTACTS: AutoTagContact[] = [
  {
    id: 1,
    displayName: "Ada Lovelace",
    title: "Partner",
    company: "Analytical Ventures",
    location: null,
    bio: null,
    workHistory: [],
    existingTags: ["friend"],
  },
];

describe("parseTagSuggestions", () => {
  const ALL_TAGS = ["investor", "friend"];

  it("recomputes isNewTag against the owner's real tag list", () => {
    const text = JSON.stringify({
      suggestions: [
        {
          contactId: 1,
          tagName: "Investor",
          isNewTag: true, // the model's claim is wrong — 'investor' exists
          confidence: 0.9,
          rationale: "VC partner",
        },
        {
          contactId: 1,
          tagName: "biotech",
          isNewTag: false, // wrong in the other direction
          confidence: 0.6,
          rationale: "sector",
        },
      ],
    });
    const parsed = parseTagSuggestions(text, CONTACTS, ALL_TAGS)!;
    expect(parsed).toHaveLength(2);
    expect(parsed[0].isNewTag).toBe(false);
    expect(parsed[1].isNewTag).toBe(true);
  });

  it("drops suggestions for unknown contacts and already-applied tags", () => {
    const text = JSON.stringify({
      suggestions: [
        { contactId: 99, tagName: "investor", isNewTag: false, confidence: 0.9, rationale: "x" },
        { contactId: 1, tagName: "Friend", isNewTag: false, confidence: 0.9, rationale: "x" },
        { contactId: 1, tagName: "investor", isNewTag: false, confidence: 0.9, rationale: "x" },
      ],
    });
    const parsed = parseTagSuggestions(text, CONTACTS, ALL_TAGS)!;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].tagName).toBe("investor");
  });

  it("returns null on unusable output instead of half-applying", () => {
    expect(parseTagSuggestions("not json", CONTACTS, ALL_TAGS)).toBeNull();
    expect(
      parseTagSuggestions(
        JSON.stringify({ suggestions: [{ contactId: 1 }] }),
        CONTACTS,
        ALL_TAGS
      )
    ).toBeNull();
  });
});

describe("buildAutoTagSystem", () => {
  it("carries the existing tags and the prefer-existing instruction", () => {
    const system = buildAutoTagSystem(["investor", "biotech"]);
    expect(system).toContain('"investor"');
    expect(system).toContain("prefer existing tags");
  });
});

describe("parseOpeners", () => {
  it("parses and caps at three openers", () => {
    const text = JSON.stringify({ openers: ["a", "b", "c", "d"] });
    expect(parseOpeners(text)).toEqual(["a", "b", "c"]);
  });

  it("returns null on unusable output", () => {
    expect(parseOpeners("nope")).toBeNull();
    expect(parseOpeners(JSON.stringify({ openers: [] }))).toBeNull();
  });
});

describe("meeting prep (SPEC §9e)", () => {
  it("parses up to three points and rejects junk", () => {
    expect(parseTalkingPoints('{"points":["a","b","c","d"]}')).toEqual(["a", "b", "c"]);
    expect(parseTalkingPoints('{"points":[]}')).toBeNull();
    expect(parseTalkingPoints("not json")).toBeNull();
    expect(parseTalkingPoints('{"openers":["x"]}')).toBeNull();
  });

  it("puts every grounding fact in the prompt, and says when there is none", () => {
    const prompt = buildMeetingPrepPrompt({
      meetingSummary: "Q3 catch-up",
      displayName: "Ana Silva",
      title: "Partner",
      company: "Meridian",
      history: ["You emailed — Intro to Diego · 14d ago"],
      changes: [{ field: "company", oldValue: "Stripe", newValue: "Meridian" }],
      notes: ["Wants biotech intros"],
    });
    for (const s of ["Q3 catch-up", "Ana Silva", "Partner at Meridian", "Stripe → Meridian", "Intro to Diego", "Wants biotech intros"]) {
      expect(prompt).toContain(s);
    }
    const thin = buildMeetingPrepPrompt({
      meetingSummary: null,
      displayName: "X",
      title: null,
      company: null,
      history: [],
      changes: [],
      notes: [],
    });
    expect(thin).toContain("No recorded history");
    expect(thin).toContain("no notes");
  });
});
