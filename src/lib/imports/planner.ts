// The diff planner: given an incoming row and the matched stored contact
// (or null), produce the exact writes/conflicts per SPEC §8's rules.
// Pure — identity lookup and application live in src/server/imports.ts.

import { normalizeEmail } from "@/lib/contacts/normalize";
import type {
  FieldConflict,
  FieldWrite,
  ImportRow,
  RowPlan,
  ScalarField,
} from "./types";
import { SCALAR_FIELDS } from "./types";

export type StoredSnapshot = {
  id: number;
  values: Record<ScalarField, string | null>;
  /** field → source that last set it ('user', 'csv', …). Missing = never set. */
  provenance: Partial<Record<ScalarField, string>>;
  emailsNormalized: string[];
  phonesE164: string[];
  phonesRaw: string[];
  socialUrls: string[];
};

const LEGAL_SUFFIX_RE =
  /[\s,]+(inc\.?|llc|ltd\.?|gmbh|ag|sa|sarl|s\.a\.|corp\.?|co\.?|plc)$/i;

/** Equality normalization: case/whitespace-insensitive; company also drops
 * legal suffixes (SPEC §5: "google" → "Google" is not a change). */
export function normalizeForCompare(field: ScalarField, value: string): string {
  let v = value.trim().replace(/\s+/g, " ").toLowerCase();
  if (field === "company") v = v.replace(LEGAL_SUFFIX_RE, "").trim();
  return v;
}

export function birthdayString(b: NonNullable<ImportRow["birthday"]>): string {
  const mmdd = `${String(b.month).padStart(2, "0")}-${String(b.day).padStart(2, "0")}`;
  return b.year ? `${mmdd}-${b.year}` : mmdd;
}

/** Derive first/last from fullName when the source only has one name field. */
export function effectiveName(row: ImportRow): {
  firstName: string | null;
  lastName: string | null;
} {
  if (row.firstName || row.lastName) {
    return {
      firstName: row.firstName?.trim() || null,
      lastName: row.lastName?.trim() || null,
    };
  }
  const full = row.fullName?.trim().replace(/\s+/g, " ");
  if (!full) return { firstName: null, lastName: null };
  const parts = full.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

function incomingScalars(row: ImportRow): Record<ScalarField, string | null> {
  const name = effectiveName(row);
  return {
    first_name: name.firstName,
    last_name: name.lastName,
    title: row.title?.trim() || null,
    company: row.company?.trim() || null,
    location: row.location?.trim() || null,
    bio: row.bio?.trim() || null,
    birthday: row.birthday ? birthdayString(row.birthday) : null,
  };
}

export function planRow(
  row: ImportRow,
  matched: StoredSnapshot | null,
  source: string,
  toE164: (raw: string) => string | null
): RowPlan {
  const incoming = incomingScalars(row);
  const displayName =
    [incoming.first_name, incoming.last_name].filter(Boolean).join(" ") ||
    row.emails[0]?.email ||
    row.phones[0]?.phone ||
    "Unnamed";

  if (!matched) {
    return {
      status: "new",
      contactId: null,
      matchedBy: null,
      displayName,
      writes: SCALAR_FIELDS.filter((f) => incoming[f] !== null).map((f) => ({
        field: f,
        incoming: incoming[f] as string,
        previous: null,
      })),
      conflicts: [],
      newEmails: dedupeEmails(row.emails),
      newPhones: row.phones,
      newSocials: dedupeSocials(row.socials),
    };
  }

  const writes: FieldWrite[] = [];
  const conflicts: FieldConflict[] = [];
  for (const field of SCALAR_FIELDS) {
    const inc = incoming[field];
    if (inc === null) continue; // never delete on import
    const stored = matched.values[field];
    if (stored === null || stored === "") {
      writes.push({ field, incoming: inc, previous: null });
      continue;
    }
    if (normalizeForCompare(field, stored) === normalizeForCompare(field, inc)) {
      continue; // unchanged — keep stored casing
    }
    const storedSource = matched.provenance[field] ?? "user";
    if (storedSource === source) {
      // Same source updated its own value → overwrite (SPEC §8).
      writes.push({ field, incoming: inc, previous: stored });
    } else {
      // User-edited or another source → keep stored, report conflict.
      conflicts.push({ field, incoming: inc, stored, storedSource });
    }
  }

  const storedEmailSet = new Set(matched.emailsNormalized);
  const newEmails = dedupeEmails(row.emails).filter(
    (e) => !storedEmailSet.has(normalizeEmail(e.email))
  );
  const storedPhoneE164 = new Set(matched.phonesE164);
  const storedPhoneRaw = new Set(matched.phonesRaw.map(digits));
  const newPhones = row.phones.filter((p) => {
    const e164 = toE164(p.phone);
    if (e164) return !storedPhoneE164.has(e164);
    return !storedPhoneRaw.has(digits(p.phone));
  });
  const storedUrlSet = new Set(matched.socialUrls);
  const newSocials = dedupeSocials(row.socials).filter(
    (s) => !storedUrlSet.has(s.url)
  );

  const hasWrites =
    writes.length > 0 ||
    newEmails.length > 0 ||
    newPhones.length > 0 ||
    newSocials.length > 0;

  return {
    status: conflicts.length > 0 ? "conflict" : hasWrites ? "updated" : "unchanged",
    contactId: matched.id,
    matchedBy: null, // filled by the caller, which knows how it matched
    displayName,
    writes,
    conflicts,
    newEmails,
    newPhones,
    newSocials,
  };
}

function dedupeEmails(emails: ImportRow["emails"]): ImportRow["emails"] {
  const seen = new Set<string>();
  return emails.filter((e) => {
    const n = normalizeEmail(e.email);
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

function dedupeSocials(socials: ImportRow["socials"]): ImportRow["socials"] {
  const seen = new Set<string>();
  return socials.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

function digits(s: string): string {
  return s.replaceAll(/\D/g, "");
}
