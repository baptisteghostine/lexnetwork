// Markdown formatting helpers behind the note toolbar (SPEC §2, owner
// request 2026-09-22). Pure — no React, no DOM: each helper takes the
// text plus the selection and returns the new text with where the
// selection should land, so a textarea can apply it and tests can pin
// the exact behaviour.

export type Selection = { start: number; end: number };
export type FormatResult = { text: string; start: number; end: number };

export type InlineFormat = "bold" | "italic" | "underline";
export type BlockFormat = "h1" | "h2" | "bullets" | "numbered";
export type Format = InlineFormat | BlockFormat;

// Underline has no markdown syntax; `<u>` is the one HTML tag the
// renderer understands (see lib/notes/underline.ts).
const INLINE: Record<InlineFormat, { open: string; close: string }> = {
  bold: { open: "**", close: "**" },
  italic: { open: "_", close: "_" },
  underline: { open: "<u>", close: "</u>" },
};

const PLACEHOLDER: Record<InlineFormat, string> = {
  bold: "bold text",
  italic: "italic text",
  underline: "underlined text",
};

/**
 * Wrap the selection in the inline marker, or unwrap it when it is
 * already wrapped (so the button toggles). An empty selection inserts a
 * placeholder and selects it, so typing replaces it.
 */
export function toggleInline(
  text: string,
  sel: Selection,
  format: InlineFormat
): FormatResult {
  const { open, close } = INLINE[format];
  const start = Math.min(sel.start, sel.end);
  const end = Math.max(sel.start, sel.end);
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);

  // Already wrapped, markers just outside the selection → unwrap.
  if (before.endsWith(open) && after.startsWith(close)) {
    return {
      text: before.slice(0, -open.length) + selected + after.slice(close.length),
      start: start - open.length,
      end: end - open.length,
    };
  }
  // Already wrapped, markers inside the selection → unwrap.
  if (
    selected.startsWith(open) &&
    selected.endsWith(close) &&
    selected.length >= open.length + close.length
  ) {
    const inner = selected.slice(open.length, selected.length - close.length);
    return { text: before + inner + after, start, end: start + inner.length };
  }
  const body = selected || PLACEHOLDER[format];
  return {
    text: before + open + body + close + after,
    start: start + open.length,
    end: start + open.length + body.length,
  };
}

function lineBounds(text: string, sel: Selection): { from: number; to: number } {
  const start = Math.min(sel.start, sel.end);
  const end = Math.max(sel.start, sel.end);
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = text.indexOf("\n", end);
  const to = nextBreak === -1 ? text.length : nextBreak;
  return { from, to };
}

const HEADING_RE = /^#{1,6}\s+/;
const BULLET_RE = /^[-*]\s+/;
const NUMBER_RE = /^\d+\.\s+/;

/**
 * Apply a block format to every line the selection touches. Headings
 * toggle (a second press removes them); list formats renumber and toggle
 * the same way. The whole block ends up selected.
 */
export function toggleBlock(
  text: string,
  sel: Selection,
  format: BlockFormat
): FormatResult {
  const { from, to } = lineBounds(text, sel);
  const lines = text.slice(from, to).split("\n");
  const strip = (l: string) =>
    l.replace(HEADING_RE, "").replace(BULLET_RE, "").replace(NUMBER_RE, "");

  let out: string[];
  if (format === "h1" || format === "h2") {
    const marker = format === "h1" ? "# " : "## ";
    const allSet = lines.every((l) => l.startsWith(marker));
    out = lines.map((l) => (allSet ? l.slice(marker.length) : marker + strip(l)));
  } else if (format === "bullets") {
    const allSet = lines.every((l) => BULLET_RE.test(l));
    out = lines.map((l) => (allSet ? l.replace(BULLET_RE, "") : "- " + strip(l)));
  } else {
    const allSet = lines.every((l) => NUMBER_RE.test(l));
    out = lines.map((l, i) =>
      allSet ? l.replace(NUMBER_RE, "") : `${i + 1}. ` + strip(l)
    );
  }
  const block = out.join("\n");
  return { text: text.slice(0, from) + block + text.slice(to), start: from, end: from + block.length };
}

export function applyFormat(text: string, sel: Selection, format: Format): FormatResult {
  return format === "bold" || format === "italic" || format === "underline"
    ? toggleInline(text, sel, format)
    : toggleBlock(text, sel, format);
}

/** Keyboard shortcut → format, for the editor's keydown handler. */
export function shortcutFormat(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): Format | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (e.shiftKey) {
    if (k === "8") return "bullets";
    if (k === "7") return "numbered";
    return null;
  }
  if (k === "b") return "bold";
  if (k === "i") return "italic";
  if (k === "u") return "underline";
  return null;
}
