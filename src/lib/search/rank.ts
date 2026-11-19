// Pure search-ranking helpers: FTS produces candidates, these decide the
// order (SCHEMA.md search flow: FTS → Jaro-Winkler + nickname re-rank).

import { nicknameEquivalents, nicknamesMatch } from "@/lib/dedupe/nicknames";
import { jaroWinkler } from "@/lib/search/jaro";

export function normalizeForSearch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

/** A query as the words to look for: normalized, split on whitespace. */
export function queryWords(query: string): string[] {
  return normalizeForSearch(query).split(/\s+/).filter(Boolean);
}

/**
 * Does `word` begin a word somewhere in `text`? Both already normalized.
 * "ana" is in "ana silva" and "senior analyst" but not in "managing";
 * "m&a" is in "tmt m&a" — the boundary is "not preceded by a letter or
 * digit", so punctuation inside a term is kept.
 */
export function startsAWord(text: string, word: string): boolean {
  if (!word) return true;
  let at = text.indexOf(word);
  while (at !== -1) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1])) return true;
    at = text.indexOf(word, at + 1);
  }
  return false;
}

/** Every word of the query begins a word in the text. */
export function matchesEveryWord(text: string, words: string[]): boolean {
  const haystack = normalizeForSearch(text);
  return words.every((w) => startsAWord(haystack, w));
}

/**
 * How well `query` matches a person's name: best Jaro-Winkler across name
 * tokens and the full name, with a floor of 0.93 for nickname-equivalent
 * first tokens (katee→kate→katherine style hits).
 */
export function nameScore(query: string, displayName: string): number {
  const q = normalizeForSearch(query);
  const name = normalizeForSearch(displayName);
  if (!q || !name) return 0;
  const tokens = name.split(/\s+/);
  let best = jaroWinkler(q, name);
  for (const t of tokens) {
    best = Math.max(best, jaroWinkler(q, t));
    if (nicknamesMatch(q, t)) best = Math.max(best, 0.93);
  }
  return best;
}

/**
 * FTS5 MATCH expression for a user query: every token quoted (so `"` and
 * operators can't 500 the query — SPEC §7 edge case), OR-combined with
 * nickname equivalents and a leading-trigram probe so near-miss spellings
 * ("katee") still surface trigram candidates ("kat" → Katherine).
 */
export function ftsQueryForContacts(query: string): string | null {
  const q = normalizeForSearch(query);
  if (q.length < 3) return null; // trigram needs 3 chars; caller falls back to LIKE
  const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
  const parts = new Set<string>();
  parts.add(quote(q));
  for (const token of q.split(/\s+/)) {
    if (token.length >= 3) {
      parts.add(quote(token));
      parts.add(quote(token.slice(0, 3)));
    }
    for (const eq of nicknameEquivalents(token)) {
      if (eq.length >= 3) parts.add(quote(eq));
    }
  }
  return [...parts].join(" OR ");
}

/** Word-based MATCH for note bodies; last token matches as a prefix. */
export function ftsQueryForNotes(query: string): string | null {
  const q = normalizeForSearch(query);
  const tokens = q.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
  return tokens
    .map((t, i) => (i === tokens.length - 1 ? `${quote(t)}*` : quote(t)))
    .join(" ");
}
