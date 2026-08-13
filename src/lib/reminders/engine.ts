import { RRule } from "rrule";

// Dependency justification (PLAN Phase 5): RFC 5545 recurrence is a
// solved-problem minefield — rrule is the standard implementation.

// SPEC §4 subset: FREQ daily/weekly/monthly/yearly, INTERVAL, BYDAY,
// BYMONTHDAY, UNTIL/COUNT.
const ALLOWED_KEYS = new Set([
  "FREQ",
  "INTERVAL",
  "BYDAY",
  "BYMONTHDAY",
  "UNTIL",
  "COUNT",
]);
const ALLOWED_FREQ = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);

/**
 * Validates an RRULE string against the SPEC §4 subset. Returns a
 * normalized "KEY=VAL;…" string, or null when invalid.
 */
export function sanitizeRrule(input: string): string | null {
  const body = input.trim().replace(/^RRULE:/i, "");
  if (!body) return null;
  const parts: string[] = [];
  let freqSeen = false;
  for (const piece of body.split(";")) {
    if (!piece) continue;
    const eq = piece.indexOf("=");
    if (eq < 0) return null;
    const key = piece.slice(0, eq).toUpperCase();
    const val = piece.slice(eq + 1).toUpperCase();
    if (!ALLOWED_KEYS.has(key) || !val) return null;
    if (key === "FREQ") {
      if (!ALLOWED_FREQ.has(val)) return null;
      freqSeen = true;
    }
    parts.push(`${key}=${val}`);
  }
  if (!freqSeen) return null;
  try {
    RRule.fromString(`RRULE:${parts.join(";")}`);
  } catch {
    return null;
  }
  return parts.join(";");
}

/**
 * The first occurrence strictly after `afterMs` for a series anchored at
 * `dtstartMs` (the defining reminder's due_at). Returns null when the rule
 * is exhausted (UNTIL passed / COUNT consumed) — SPEC §4: the series
 * auto-completes. Inclusive of dtstart itself when it lies after `afterMs`.
 */
export function nextOccurrence(
  rruleStr: string,
  dtstartMs: number,
  afterMs: number
): number | null {
  let rule: RRule;
  try {
    rule = new RRule({
      ...RRule.parseString(rruleStr),
      dtstart: new Date(dtstartMs),
    });
  } catch {
    return null;
  }
  const next = rule.after(new Date(afterMs), false);
  return next ? next.getTime() : null;
}

/** Human summary for list rows ("every month on the 2nd Tuesday"). */
export function describeRrule(rruleStr: string): string {
  try {
    return RRule.fromString(`RRULE:${rruleStr}`).toText();
  } catch {
    return rruleStr;
  }
}
