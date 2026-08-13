import { describe, expect, it } from "vitest";

import {
  activeTrigger,
  mentionMarkdown,
  parseMentions,
} from "@/lib/notes/mentions";

describe("parseMentions", () => {
  it("extracts contact and group mentions", () => {
    const body =
      "Met [@Ana Silva](mention://contact/12) at the [#NYC Founders](mention://group/3) dinner.";
    expect(parseMentions(body)).toEqual([
      { kind: "contact", id: 12, label: "@Ana Silva" },
      { kind: "group", id: 3, label: "#NYC Founders" },
    ]);
  });

  it("dedupes repeated mentions of the same target", () => {
    const body =
      "[@Ana](mention://contact/12) and again [@Ana Silva](mention://contact/12)";
    expect(parseMentions(body)).toHaveLength(1);
  });

  it("ignores ordinary links and malformed mention URIs", () => {
    const body =
      "[site](https://example.com) [@x](mention://contact/abc) [@y](mention://person/1)";
    expect(parseMentions(body)).toEqual([]);
  });

  it("returns empty for empty body", () => {
    expect(parseMentions("")).toEqual([]);
  });
});

describe("mentionMarkdown", () => {
  it("adds the sigil when missing and preserves it when present", () => {
    expect(
      mentionMarkdown({ kind: "contact", id: 5, label: "Bob Smith" })
    ).toBe("[@Bob Smith](mention://contact/5)");
    expect(mentionMarkdown({ kind: "group", id: 2, label: "#VIP" })).toBe(
      "[#VIP](mention://group/2)"
    );
  });
});

describe("activeTrigger", () => {
  it("detects @ at start of text", () => {
    expect(activeTrigger("@An", 3)).toEqual({
      sigil: "@",
      query: "An",
      start: 0,
    });
  });

  it("detects # after whitespace mid-text", () => {
    const text = "dinner with #fou";
    expect(activeTrigger(text, text.length)).toEqual({
      sigil: "#",
      query: "fou",
      start: 12,
    });
  });

  it("returns null when caret is not in a trigger", () => {
    expect(activeTrigger("plain text", 5)).toBeNull();
    expect(activeTrigger("email@example.com", 17)).toBeNull();
  });

  it("returns null once whitespace ends the query", () => {
    const text = "@Ana Silva";
    expect(activeTrigger(text, text.length)).toBeNull();
  });

  it("handles caret mid-text, not just at end", () => {
    const text = "see @Bo later";
    expect(activeTrigger(text, 7)).toEqual({
      sigil: "@",
      query: "Bo",
      start: 4,
    });
  });
});
