// Full-fidelity export (SPEC §13): everything the owner's Rolo knows, as
// one ZIP — a flattened contacts.csv that re-imports through the normal
// CSV path, plus one JSON file per table, plus the attachments directory.
// Everything here is generator-based so the route handler can stream the
// archive without ever holding a whole table (or the ZIP) in memory.

import type { Database } from "better-sqlite3";

// FTS virtual tables (and their shadow tables) are derived indexes —
// rebuilt by triggers on restore, meaningless to export. The Drizzle
// journal table describes the schema, not the data.
const SKIP_TABLE = /^(sqlite_|__drizzle|.*_fts(_|$))/;

export function listExportTables(db: Database): string[] {
  const rows = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    )
    .all();
  return rows.map((r) => r.name).filter((n) => !SKIP_TABLE.test(n));
}

export function tableRowCount(db: Database, table: string): number {
  // Table names come from sqlite_master, not user input — but quote anyway.
  const row = db
    .prepare<[], { n: number }>(`SELECT count(*) AS n FROM "${table}"`)
    .get();
  return row?.n ?? 0;
}

/**
 * One table as a JSON array, yielded in string chunks. Rows are emitted
 * via the statement iterator so a 50k-row table streams instead of
 * materializing.
 */
export function* tableJsonChunks(
  db: Database,
  table: string
): Generator<string> {
  yield "[";
  let first = true;
  for (const row of db.prepare(`SELECT * FROM "${table}"`).iterate()) {
    yield `${first ? "" : ","}\n  ${JSON.stringify(row)}`;
    first = false;
  }
  yield "\n]\n";
}

/**
 * Restore per-table JSON (the export's own output) into a database built
 * from the same migrations — the "JSON path" of SPEC §13's fidelity AC and
 * the manual escape hatch when a SQLite backup isn't at hand. Insert order
 * is caller-irrelevant: foreign keys are suspended for the transaction.
 */
export function restoreTableJson(
  db: Database,
  table: string,
  json: string
): number {
  if (SKIP_TABLE.test(table)) throw new Error(`refusing to restore ${table}`);
  const rows = JSON.parse(json) as Record<string, unknown>[];
  if (!Array.isArray(rows)) throw new Error(`${table}.json is not an array`);
  if (rows.length === 0) return 0;
  db.pragma("foreign_keys = OFF");
  try {
    const run = db.transaction(() => {
      for (const row of rows) {
        const cols = Object.keys(row);
        db.prepare(
          `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")})
           VALUES (${cols.map((c) => `@${c}`).join(",")})`
        ).run(row);
      }
    });
    run();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// contacts.csv — flattened so `guessMapping` re-maps every column on
// re-import (headers deliberately use Google-Contacts-style shapes the
// guesser already recognizes). Trailing columns are informational and
// auto-map to "ignore".

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

type FlatRow = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  display_name: string;
  title: string | null;
  company: string | null;
  location: string | null;
  bio: string | null;
  description_md: string | null;
  birthday_month: number | null;
  birthday_day: number | null;
  birthday_year: number | null;
  starred: number;
  archived_at: number | null;
  cadence_days: number | null;
};

export function* contactsCsvChunks(db: Database): Generator<string> {
  const maxEmails = Math.max(
    1,
    db
      .prepare<[], { n: number }>(
        "SELECT count(*) AS n FROM contact_emails GROUP BY contact_id ORDER BY n DESC LIMIT 1"
      )
      .get()?.n ?? 1
  );
  const maxPhones = Math.max(
    1,
    db
      .prepare<[], { n: number }>(
        "SELECT count(*) AS n FROM contact_phones GROUP BY contact_id ORDER BY n DESC LIMIT 1"
      )
      .get()?.n ?? 1
  );

  const header = [
    "First Name",
    "Last Name",
    "Full Name",
    "Title",
    "Company",
    "Location",
    "Bio",
    "Birthday",
    ...Array.from({ length: maxEmails }, (_, i) => `E-mail ${i + 1} - Value`),
    ...Array.from({ length: maxPhones }, (_, i) => `Phone ${i + 1} - Value`),
    "LinkedIn",
    "Website 1 - Value",
    // Informational — the importer's guesser maps these to "ignore".
    "Tags",
    "Groups",
    "Starred",
    "Archived",
    "Cadence Days",
    "Description (Markdown)",
  ];
  yield header.map(csvCell).join(",") + "\r\n";

  const emailsStmt = db.prepare<[number], { email: string }>(
    "SELECT email FROM contact_emails WHERE contact_id = ? ORDER BY priority, id"
  );
  const phonesStmt = db.prepare<[number], { phone_raw: string }>(
    "SELECT phone_raw FROM contact_phones WHERE contact_id = ? ORDER BY priority, id"
  );
  const socialStmt = db.prepare<[number, string], { url: string }>(
    "SELECT url FROM contact_socials WHERE contact_id = ? AND platform = ? ORDER BY id"
  );
  const tagsStmt = db.prepare<[number], { name: string }>(
    `SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
     WHERE ct.contact_id = ? ORDER BY t.name`
  );
  const groupsStmt = db.prepare<[number], { name: string }>(
    `SELECT g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id
     WHERE gm.contact_id = ? ORDER BY g.name`
  );

  const contactsIter = db
    .prepare("SELECT * FROM contacts ORDER BY id")
    .iterate() as IterableIterator<FlatRow>;
  for (const c of contactsIter) {
    const emails = emailsStmt.all(c.id).map((r) => r.email);
    const phones = phonesStmt.all(c.id).map((r) => r.phone_raw);
    const linkedin = socialStmt.get(c.id, "linkedin")?.url ?? "";
    const website = socialStmt.get(c.id, "website")?.url ?? "";
    const birthday =
      c.birthday_month && c.birthday_day
        ? c.birthday_year
          ? `${c.birthday_year}-${String(c.birthday_month).padStart(2, "0")}-${String(c.birthday_day).padStart(2, "0")}`
          : `--${String(c.birthday_month).padStart(2, "0")}-${String(c.birthday_day).padStart(2, "0")}`
        : "";
    const cells = [
      c.first_name,
      c.last_name,
      // Full Name only when first/last are both missing — otherwise the
      // importer would double-derive.
      c.first_name || c.last_name ? "" : c.display_name,
      c.title,
      c.company,
      c.location,
      c.bio,
      birthday,
      ...Array.from({ length: maxEmails }, (_, i) => emails[i] ?? ""),
      ...Array.from({ length: maxPhones }, (_, i) => phones[i] ?? ""),
      linkedin,
      website,
      tagsStmt.all(c.id).map((r) => r.name).join(" ::: "),
      groupsStmt.all(c.id).map((r) => r.name).join(" ::: "),
      c.starred ? "1" : "0",
      c.archived_at ? "1" : "0",
      c.cadence_days,
      c.description_md,
    ];
    yield cells.map(csvCell).join(",") + "\r\n";
  }
}

export type ExportManifest = {
  exportedAt: number;
  format: 1;
  tables: { name: string; rows: number }[];
  attachmentsIncluded: boolean;
};
