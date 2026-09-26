import { describe, expect, it } from "vitest";

import {
  applyFormat,
  noteSnippet,
  shortcutFormat,
  toggleBlock,
  toggleInline,
} from "@/lib/notes/format";

// SPEC §2 note toolbar: every button is a pure text transform, so the
// exact markdown it writes — and that a second press undoes it — is
// pinned here rather than eyeballed in the browser.

describe("toggleInline", () => {
  it("wraps a selection in bold and selects the inner text", () => {
    const r = toggleInline("say hello there", { start: 4, end: 9 }, "bold");
    expect(r).toEqual({ text: "say **hello** there", start: 6, end: 11 });
  });

  it("unwraps when the selection is already wrapped", () => {
    const r = toggleInline("say **hello** there", { start: 6, end: 11 }, "bold");
    expect(r).toEqual({ text: "say hello there", start: 4, end: 9 });
  });

  it("unwraps when the markers are inside the selection", () => {
    const r = toggleInline("say _hi_ there", { start: 4, end: 8 }, "italic");
    expect(r).toEqual({ text: "say hi there", start: 4, end: 6 });
  });

  it("inserts a selected placeholder on an empty selection", () => {
    const r = toggleInline("note: ", { start: 6, end: 6 }, "underline");
    expect(r.text).toBe("note: <u>underlined text</u>");
    expect(r.text.slice(r.start, r.end)).toBe("underlined text");
  });

  it("handles a backwards selection", () => {
    const r = toggleInline("ab cd", { start: 5, end: 3 }, "bold");
    expect(r.text).toBe("ab **cd**");
  });
});

describe("toggleBlock", () => {
  const text = "first\nsecond\nthird";

  it("makes every selected line a bullet and selects the block", () => {
    const r = toggleBlock(text, { start: 2, end: 8 }, "bullets");
    expect(r.text).toBe("- first\n- second\nthird");
    expect(r.text.slice(r.start, r.end)).toBe("- first\n- second");
  });

  it("numbers lines from 1 and removes numbering on a second press", () => {
    const once = toggleBlock(text, { start: 0, end: text.length }, "numbered");
    expect(once.text).toBe("1. first\n2. second\n3. third");
    const twice = toggleBlock(once.text, { start: once.start, end: once.end }, "numbered");
    expect(twice.text).toBe(text);
  });

  it("swaps one block format for another instead of stacking", () => {
    const bullets = toggleBlock(text, { start: 0, end: 0 }, "bullets");
    expect(bullets.text).toBe("- first\nsecond\nthird");
    const heading = toggleBlock(bullets.text, { start: 0, end: 0 }, "h2");
    expect(heading.text).toBe("## first\nsecond\nthird");
    const off = toggleBlock(heading.text, { start: 0, end: 0 }, "h2");
    expect(off.text).toBe(text);
  });

  it("works on the caret line when nothing is selected", () => {
    const r = applyFormat("a\nbb\nc", { start: 3, end: 3 }, "h1");
    expect(r.text).toBe("a\n# bb\nc");
  });
});

describe("shortcutFormat", () => {
  const key = (k: string, mods: Partial<Parameters<typeof shortcutFormat>[0]> = {}) =>
    shortcutFormat({ key: k, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...mods });

  it("maps Ctrl/Cmd+B/I/U and the list chords", () => {
    expect(key("b")).toBe("bold");
    expect(key("I", { ctrlKey: false, metaKey: true })).toBe("italic");
    expect(key("u")).toBe("underline");
    expect(key("8", { shiftKey: true })).toBe("bullets");
    expect(key("7", { shiftKey: true })).toBe("numbered");
    // What a real keydown carries with Shift held on a US/UK layout.
    expect(key("*", { shiftKey: true, code: "Digit8" })).toBe("bullets");
    expect(key("&", { shiftKey: true, code: "Digit7" })).toBe("numbered");
    expect(key("*", { shiftKey: true })).toBe("bullets");
  });

  it("ignores plain keys and Alt combinations", () => {
    expect(key("b", { ctrlKey: false })).toBeNull();
    expect(key("b", { altKey: true })).toBeNull();
    expect(key("x")).toBeNull();
  });
});

describe("noteSnippet", () => {
  it("flattens markdown to one plain line", () => {
    expect(
      noteSnippet("# Coffee\n\n- met [@Ana](mention://contact/1) at **Blue** Bottle\n- <u>next</u>: intro")
    ).toBe("Coffee met @Ana at Blue Bottle next: intro");
  });

  it("cuts on a word with an ellipsis", () => {
    const s = noteSnippet("alpha beta gamma delta", 12);
    expect(s).toBe("alpha beta…");
  });
});
