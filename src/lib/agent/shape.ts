// How the connector's answers are shaped (SPEC §14): compact, dated in a
// form a reader does not have to decode, and bounded. Pure.

/** Hard ceiling on one tool answer. Claude Code cuts results at 25,000
 * tokens; 60,000 characters of JSON stays under that with room to spare. */
export const RESULT_CHAR_CAP = 60_000;

/** Epoch ms → ISO-8601, or null. Agents read dates better than integers. */
export function iso(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

/** Whole days between `at` and `now`; null when `at` is. */
export function daysAgo(at: number | null | undefined, now: number): number | null {
  if (at === null || at === undefined) return null;
  return Math.max(0, Math.floor((now - at) / 86_400_000));
}

/** Collapse whitespace and cut with an ellipsis. Null stays null. */
export function clip(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Cut keeping line breaks — for message and note bodies. */
export function clipBody(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  const body = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!body) return null;
  return body.length <= max ? body : `${body.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** "YYYY-MM-DD" (UTC midnight) or a full ISO timestamp → epoch ms, or null. */
export function parseDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return null;
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Serialise an answer, and if it is over the cap, shed the list named by
 * `shrink` from its tail until it fits — saying so in the answer, because
 * a silently short list reads as "that is everyone".
 */
export function serializeCapped(
  data: Record<string, unknown>,
  shrink?: string,
  cap = RESULT_CHAR_CAP
): string {
  let text = JSON.stringify(data);
  if (text.length <= cap) return text;
  const list = shrink ? data[shrink] : undefined;
  if (!shrink || !Array.isArray(list)) {
    return JSON.stringify({
      error: "This answer was too large to return. Narrow the request.",
      truncated: true,
    });
  }
  const kept = [...list];
  // Down to one item; if even that does not fit, an empty list would read
  // as "nothing matched", so it falls through to the error instead.
  while (kept.length > 1) {
    kept.pop();
    text = JSON.stringify({
      ...data,
      [shrink]: kept,
      truncated: true,
      truncatedNote: `Only the first ${kept.length} of ${list.length} fit in one answer. Ask for fewer at a time.`,
    });
    if (text.length <= cap) return text;
  }
  return JSON.stringify({
    error: "This answer was too large to return. Narrow the request.",
    truncated: true,
  });
}
