// Shared shapes for the import pipeline. Pure types — no DB, no React.

export type ImportSource = "csv" | "vcard" | "linkedin" | "google_contacts";

/** One person as extracted from an import file, source-agnostic. */
export type ImportRow = {
  firstName?: string;
  lastName?: string;
  /** Used when the source only has a single name field. */
  fullName?: string;
  title?: string;
  company?: string;
  location?: string;
  bio?: string;
  birthday?: { month: number; day: number; year: number | null };
  emails: { email: string; label?: string }[];
  phones: { phone: string; label?: string }[];
  socials: { platform: string; url: string }[];
  /** Base64-encoded photo, if the source carried one (vCard PHOTO). */
  photoBase64?: { data: string; mime: string };
  /** Original row values, kept for the diff report. */
  raw?: Record<string, string>;
};

export const SCALAR_FIELDS = [
  "first_name",
  "last_name",
  "title",
  "company",
  "location",
  "bio",
  "birthday",
] as const;
export type ScalarField = (typeof SCALAR_FIELDS)[number];

export type FieldWrite = {
  field: ScalarField;
  incoming: string;
  previous: string | null;
};

export type FieldConflict = {
  field: ScalarField;
  incoming: string;
  stored: string | null;
  /** Why it conflicted: stored was user-edited, or set by another source. */
  storedSource: string;
};

export type RowPlan = {
  status: "new" | "updated" | "unchanged" | "conflict" | "error";
  /** Existing contact matched by the identity ladder (null → insert). */
  contactId: number | null;
  matchedBy: "email" | "phone" | "name" | null;
  displayName: string;
  writes: FieldWrite[];
  conflicts: FieldConflict[];
  newEmails: { email: string; label?: string }[];
  newPhones: { phone: string; label?: string }[];
  newSocials: { platform: string; url: string }[];
  error?: string;
};

export type ImportStats = {
  total: number;
  new: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  errors: number;
};

export function summarize(plans: RowPlan[]): ImportStats {
  const stats: ImportStats = {
    total: plans.length,
    new: 0,
    updated: 0,
    unchanged: 0,
    conflicts: 0,
    errors: 0,
  };
  for (const p of plans) {
    if (p.status === "new") stats.new++;
    else if (p.status === "updated") stats.updated++;
    else if (p.status === "unchanged") stats.unchanged++;
    else if (p.status === "conflict") stats.conflicts++;
    else stats.errors++;
  }
  return stats;
}
