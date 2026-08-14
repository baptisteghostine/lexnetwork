import { RRule } from "rrule";

import { fromFakeUtc, toFakeUtc } from "@/lib/time";

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
 *
 * `tz` is the owner's timezone: rrule evaluates BYDAY/BYMONTHDAY against a
 * Date's UTC fields, so the instants are projected to "fake UTC" wall-clock
 * dates first and mapped back after — otherwise "every Tuesday 8pm" for a
 * UTC+1 owner materializes on Wednesdays (or drifts an hour across DST).
 * Defaults to UTC when omitted, which preserves the old behavior for
 * UTC-aligned inputs.
 */
export function nextOccurrence(
  rruleStr: string,
  dtstartMs: number,
  afterMs: number,
  tz = "UTC"
): number | null {
  let rule: RRule;
  try {
    rule = new RRule({
      ...RRule.parseString(rruleStr),
      dtstart: new Date(toFakeUtc(tz, dtstartMs)),
    });
  } catch {
    return null;
  }
  const next = rule.after(new Date(toFakeUtc(tz, afterMs)), false);
  return next ? fromFakeUtc(tz, next.getTime()) : null;
}

/** Human summary for list rows ("every month on the 2nd Tuesday"). */
export function describeRrule(rruleStr: string): string {
  try {
    return RRule.fromString(`RRULE:${rruleStr}`).toText();
  } catch {
    return rruleStr;
  }
}
