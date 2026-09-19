// Pure per-connection merge planning for LinkedIn imports: provenance
// rules from SPEC §8, job-change detection from SPEC §5. The server
// engine applies plans; this file never touches the DB.

import type { LinkedInConnection } from "@/lib/imports/linkedin";

export type LinkedInScalarField =
  | "first_name"
  | "last_name"
  | "company"
  | "title"
  | "location";

export type LinkedInSnapshot = {
  contactId: number;
  values: Record<LinkedInScalarField, string | null>;
  /** field → source that last set it (absent = never set). */
  provenance: Partial<Record<LinkedInScalarField, string>>;
};

export type LinkedInRowPlan = {
  status: "new" | "updated" | "unchanged";
  writes: { field: LinkedInScalarField; value: string }[];
  conflicts: {
    field: LinkedInScalarField;
    stored: string;
    incoming: string;
  }[];
  /** SPEC §5 job changes — only real, baselined differences. */
  changes: { field: "company" | "title"; old: string; new: string }[];
};

/** SPEC §5: trim, collapse whitespace, case- and punctuation-insensitive;
 * companies also lose legal suffixes (Inc/LLC/Ltd/GmbH & friends) and
 * trailing commas — "Sr. Engineer" → "Sr Engineer" is not a change. */
export function normalizeForChange(
  field: LinkedInScalarField,
  value: string
): string {
  let s = value.trim().replace(/\s+/g, " ").toLowerCase();
  if (field === "company") {
    s = s
      .replace(/[.,]+$/g, "")
      .replace(/[,.]?\s+(inc|llc|ltd|gmbh|ag|sa|corp|co)\.?$/i, "")
      .trim();
  }
  return s.replace(/[.,'’]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Baseline rule (SPEC §5, 2026-09-19). When one run "moves" more than a
 * fifth of the people it matched — and at least this many, so a small
 * import can't trip it — the source is describing people differently from
 * the last one (a headline where the ZIP had a Position column, say), not
 * reporting that they all changed jobs. Such a run keeps its writes, but
 * its change rows are recorded as a baseline: dismissed and notified on
 * insert, listed in the import report, never a Today card or an email.
 * Prompted by an extension sync that mailed 475 "moves" in one go.
 */
export const BASELINE_MIN_CONTACTS = 25;
export const BASELINE_SHARE = 0.2;

export function isBaselineRun(movedContacts: number, matchedContacts: number): boolean {
  return (
    movedContacts >= BASELINE_MIN_CONTACTS &&
    movedContacts > matchedContacts * BASELINE_SHARE
  );
}

function incomingScalars(
  row: LinkedInConnection
): Record<LinkedInScalarField, string | null> {
  return {
    first_name: row.firstName || null,
    last_name: row.lastName || null,
    company: row.company,
    title: row.position,
    location: row.location,
  };
}

export function planConnection(
  row: LinkedInConnection,
  snapshot: LinkedInSnapshot | null
): LinkedInRowPlan {
  const incoming = incomingScalars(row);

  if (snapshot === null) {
    // First sighting: everything is "new", never a "change" (SPEC §5).
    return {
      status: "new",
      writes: (
        Object.entries(incoming) as [LinkedInScalarField, string | null][]
      )
        .filter((e): e is [LinkedInScalarField, string] => e[1] !== null)
        .map(([field, value]) => ({ field, value })),
      conflicts: [],
      changes: [],
    };
  }

  const plan: LinkedInRowPlan = {
    status: "unchanged",
    writes: [],
    conflicts: [],
    changes: [],
  };

  for (const [field, inc] of Object.entries(incoming) as [
    LinkedInScalarField,
    string | null,
  ][]) {
    if (inc === null) continue; // imports never delete
    const stored = snapshot.values[field];
    if (stored === null || stored === "") {
      // Filling an empty field is new info, not a job change.
      plan.writes.push({ field, value: inc });
      continue;
    }
    if (field === "title" && row.titleFromHeadline) {
      // Headline rule (SPEC §5): "Visa Inc. | AUB" against a stored
      // "Analyst" is a different kind of text, not a move. Only a Position
      // column or a real job entry may change a stored title; a headline
      // isn't even allowed to overwrite one silently.
      continue;
    }
    if (normalizeForChange(field, stored) === normalizeForChange(field, inc)) {
      continue; // case/suffix-only difference — keep stored casing (SPEC §5)
    }
    const source = snapshot.provenance[field];
    if (source === undefined || source === "linkedin") {
      plan.writes.push({ field, value: inc });
      if (field === "company" || field === "title") {
        plan.changes.push({ field, old: stored, new: inc });
      }
    } else {
      // user-edited or another source: never overwrite silently (SPEC §8).
      plan.conflicts.push({ field, stored, incoming: inc });
    }
  }

  if (plan.writes.length > 0) plan.status = "updated";
  return plan;
}
