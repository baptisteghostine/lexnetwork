// Mention handling for note markdown. Pure — no DB, no React.
//
// Mentions are stored inside the markdown body as ordinary links with a
// mention:// URI, e.g.  [@Ana Silva](mention://contact/12)  or
// [#NYC Founders](mention://group/3). The note_mentions rows are always
// derived from the body by parseMentions() on save, so body and rows can
// never drift.

export type Mention = {
  kind: "contact" | "group";
  id: number;
  label: string;
};

const MENTION_RE = /\[([^\]]+)\]\(mention:\/\/(contact|group)\/(\d+)\)/g;

export function parseMentions(bodyMd: string): Mention[] {
  const seen = new Set<string>();
  const out: Mention[] = [];
  for (const m of bodyMd.matchAll(MENTION_RE)) {
    const kind = m[2] as Mention["kind"];
    const id = Number(m[3]);
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, id, label: m[1] });
  }
  return out;
}

/** Builds the markdown snippet inserted by the autocomplete. */
export function mentionMarkdown(mention: Mention): string {
  const sigil = mention.kind === "contact" ? "@" : "#";
  const label = mention.label.startsWith(sigil)
    ? mention.label
    : `${sigil}${mention.label}`;
  return `[${label}](mention://${mention.kind}/${mention.id})`;
}

/**
 * Finds an in-progress mention trigger just before the caret: an "@" or "#"
 * preceded by start-of-text/whitespace, with the query being everything from
 * the sigil to the caret (no closing bracket typed yet). Returns null when
 * the caret isn't inside a trigger.
 */
export function activeTrigger(
  text: string,
  caret: number
): { sigil: "@" | "#"; query: string; start: number } | null {
  const upto = text.slice(0, caret);
  const m = /(^|[\s(])([@#])([^\s@#[\]()]{0,50})$/.exec(upto);
  if (!m) return null;
  const sigil = m[2] as "@" | "#";
  const start = caret - m[3].length - 1;
  return { sigil, query: m[3], start };
}
