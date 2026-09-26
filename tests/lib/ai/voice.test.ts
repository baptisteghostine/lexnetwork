import { describe, expect, it } from "vitest";

import {
  buildVoicePrompt,
  hasEnoughVoiceMaterial,
  parseVoiceGuide,
  VOICE_SNIPPETS_MAX,
  VOICE_TOTAL_CHARS,
  voiceContext,
} from "@/lib/ai/voice";

// SPEC §11 voice guide: derived from what the owner actually sent, capped,
// and either present in every drafting prompt or replaced by an explicit
// neutral fallback — never silently absent.

describe("buildVoicePrompt", () => {
  it("includes examples and snippets, collapsing whitespace and dropping blanks", () => {
    const prompt = buildVoicePrompt({
      ownerName: "Baptiste",
      examples: "Hi Kate,\n\nIt's Baptiste from LBS…",
      snippets: ["Hi  Tom, quick\none", "   ", "Salut Marc — petite question"],
    });
    expect(prompt).toContain("The writer's name: Baptiste");
    expect(prompt).toContain("Full messages they pasted");
    expect(prompt).toContain("2 messages they sent");
    expect(prompt).toContain("- Hi Tom, quick one");
    expect(prompt).toContain("- Salut Marc — petite question");
  });

  it("skips a message too long for the budget instead of stopping at it", () => {
    const prompt = buildVoicePrompt({
      ownerName: null,
      examples: "",
      snippets: ["x".repeat(VOICE_TOTAL_CHARS + 10), "short one", "short two"],
    });
    expect(prompt).toContain("2 messages they sent");
    expect(prompt).toContain("- short two");
  });

  it("caps the snippet list", () => {
    const prompt = buildVoicePrompt({
      ownerName: null,
      examples: "",
      snippets: Array.from({ length: VOICE_SNIPPETS_MAX + 20 }, (_, i) => `line ${i}`),
    });
    expect(prompt).toContain(`${VOICE_SNIPPETS_MAX} messages they sent`);
    expect(prompt).not.toContain(`line ${VOICE_SNIPPETS_MAX}`);
  });
});

describe("parseVoiceGuide", () => {
  it("accepts the JSON shape and rejects a too-short guide", () => {
    expect(parseVoiceGuide('{"guide": "You open with the first name and a dash, keep it to three lines, and close with Best."}')).toMatch(/^You open/);
    expect(parseVoiceGuide('{"guide": "short"}')).toBeNull();
    expect(parseVoiceGuide("not json")).toBeNull();
  });
});

describe("hasEnoughVoiceMaterial / voiceContext", () => {
  it("needs a handful of snippets or a real pasted example", () => {
    expect(hasEnoughVoiceMaterial({ ownerName: null, examples: "", snippets: ["a", "b"] })).toBe(false);
    expect(hasEnoughVoiceMaterial({ ownerName: null, examples: "", snippets: ["a", "b", "c", "d", "e"] })).toBe(true);
    expect(hasEnoughVoiceMaterial({ ownerName: null, examples: "x".repeat(200), snippets: [] })).toBe(true);
  });

  it("wraps the guide, or states the neutral fallback", () => {
    expect(voiceContext("You write short.", "Baptiste")).toContain("<voice>\nYou write short.\n</voice>");
    expect(voiceContext(null, "Baptiste")).toMatch(/No style guide is available/);
    expect(voiceContext(null, null)).not.toContain("owner's name");
  });
});
