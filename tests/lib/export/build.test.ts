import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  contactsCsvChunks,
  listExportTables,
  restoreTableJson,
  tableJsonChunks,
  tableRowCount,
} from "@/lib/export/build";
import { parseCsv } from "@/lib/imports/csv";
import { applyMapping, guessMapping } from "@/lib/imports/mapping";

// SPEC §13 fidelity AC: the export re-imports with zero data loss. The
// JSON path is checked by round-tripping every table into a fresh
// migrations-built database and comparing; the CSV path by feeding
// contacts.csv back through the real parser + auto-guessed mapping.

const MIGRATIONS_DIR = path.join(__dirname, "../../../src/db/migrations");
const NOW = Date.UTC(2026, 7, 14, 12);

function migrate(target: Database.Database): void {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")
  ) as { entries: { tag: string }[] };
  for (const entry of journal.entries) {
    const sqlText = fs.readFileSync(
      path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
      "utf8"
    );
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

let db: Database.Database;

function seedFixture(target: Database.Database): void {
  const insertContact = target.prepare(
    `INSERT INTO contacts (first_name, last_name, display_name, title, company,
       location, bio, description_md, birthday_month, birthday_day,
       birthday_year, starred, cadence_days, created_at, updated_at)
     VALUES (@first, @last, @display, @title, @company, @location, @bio,
       @description, @bmonth, @bday, @byear, @starred, @cadence, @now, @now)`
  );
  const a = Number(
    insertContact.run({
      first: "Ana",
      last: 'Silva, "Ace"',
      display: 'Ana Silva, "Ace"',
      title: "Product Lead",
      company: "Anthropic",
      location: "San Francisco, CA",
      bio: "Met at\nthe conference",
      description: "Long *markdown* notes",
      bmonth: 3,
      bday: 14,
      byear: 1990,
      starred: 1,
      cadence: 30,
      now: NOW,
    }).lastInsertRowid
  );
  const b = Number(
    insertContact.run({
      first: null,
      last: null,
      display: "kenji@hoshi.example",
      title: null,
      company: null,
      location: null,
      bio: null,
      description: null,
      bmonth: 2,
      bday: 29,
      byear: null,
      starred: 0,
      cadence: null,
      now: NOW,
    }).lastInsertRowid
  );
  const email = target.prepare(
    `INSERT INTO contact_emails (contact_id, email, email_normalized, priority, source, created_at)
     VALUES (?, ?, ?, ?, 'user', ?)`
  );
  email.run(a, "ana.silva@example.com", "ana.silva@example.com", 0, NOW);
  email.run(a, "ana@work.example", "ana@work.example", 1, NOW);
  email.run(b, "kenji@hoshi.example", "kenji@hoshi.example", 0, NOW);
  target
    .prepare(
      `INSERT INTO contact_phones (contact_id, phone_raw, phone_e164, priority, source, created_at)
       VALUES (?, '+41 79 123 45 67', '+41791234567', 0, 'user', ?)`
    )
    .run(a, NOW);
  target
    .prepare(
      `INSERT INTO contact_socials (contact_id, platform, url, source, created_at)
       VALUES (?, 'linkedin', 'https://www.linkedin.com/in/ana-silva', 'user', ?)`
    )
    .run(a, NOW);
  const tagId = Number(
    target
      .prepare("INSERT INTO tags (name, color, created_at) VALUES ('investor', '#3b82f6', ?)")
      .run(NOW).lastInsertRowid
  );
  target
    .prepare("INSERT INTO contact_tags (contact_id, tag_id, created_at) VALUES (?, ?, ?)")
    .run(a, tagId, NOW);
  const noteId = Number(
    target
      .prepare(
        "INSERT INTO notes (contact_id, body_md, counts_for_touch, created_at, updated_at) VALUES (?, 'Intro call went well', 1, ?, ?)"
      )
      .run(a, NOW, NOW).lastInsertRowid
  );
  target
    .prepare(
      "INSERT INTO note_mentions (note_id, contact_id) VALUES (?, ?)"
    )
    .run(noteId, b);
  target
    .prepare(
      `INSERT INTO interactions (contact_id, kind, direction, occurred_at, title, source, source_key, counts_for_touch, created_at)
       VALUES (?, 'email', 'outbound', ?, 'Re: intro', 'gmail', 'msg-1', 1, ?)`
    )
    .run(a, NOW, NOW);
  target
    .prepare(
      `INSERT INTO work_history (contact_id, company, company_normalized, title, start_date, is_current, source, created_at)
       VALUES (?, 'Anthropic', 'anthropic', 'Product Lead', '2023-01', 1, 'linkedin', ?)`
    )
    .run(a, NOW);
  target
    .prepare("INSERT INTO settings (key, value) VALUES ('timezone', '\"Europe/London\"')")
    .run();
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  seedFixture(db);
});

describe("listExportTables", () => {
  it("includes every domain table and no derived/index tables", () => {
    const tables = listExportTables(db);
    for (const required of [
      "contacts",
      "contact_emails",
      "notes",
      "interactions",
      "settings",
      "sync_runs",
      "merge_log",
    ]) {
      expect(tables).toContain(required);
    }
    for (const t of tables) {
      expect(t).not.toMatch(/_fts|sqlite_|__drizzle/);
    }
  });
});

describe("JSON path — full fidelity round-trip", () => {
  it("restores into a fresh instance with zero data loss", () => {
    const restored = new Database(":memory:");
    migrate(restored);
    for (const table of listExportTables(db)) {
      const json = [...tableJsonChunks(db, table)].join("");
      // The fresh instance may have rows of its own only where migrations
      // seed none — all export tables start empty.
      expect(tableRowCount(restored, table)).toBe(0);
      restoreTableJson(restored, table, json);
    }
    for (const table of listExportTables(db)) {
      const original = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
      const roundTripped = restored
        .prepare(`SELECT * FROM "${table}" ORDER BY rowid`)
        .all();
      expect(roundTripped, table).toEqual(original);
    }
    // FTS rebuilt by triggers on the restored side: search still works.
    const hit = restored
      .prepare("SELECT rowid FROM contacts_fts WHERE contacts_fts MATCH 'Anthropic'")
      .all();
    expect(hit.length).toBe(1);
  });

  it("refuses to restore derived tables", () => {
    expect(() => restoreTableJson(db, "contacts_fts", "[]")).toThrow();
  });
});

describe("CSV path — contacts.csv re-imports through the real pipeline", () => {
  it("round-trips scalars, emails, phones, and socials via auto-guessed mapping", () => {
    const csvText = [...contactsCsvChunks(db)].join("");
    const { headers, rows } = parseCsv(csvText);
    const mapping = guessMapping(headers);
    const imported = applyMapping(headers, rows, mapping);

    expect(imported).toHaveLength(2);
    const [ana, kenji] = imported;
    expect(ana.firstName).toBe("Ana");
    expect(ana.lastName).toBe('Silva, "Ace"');
    expect(ana.title).toBe("Product Lead");
    expect(ana.company).toBe("Anthropic");
    expect(ana.location).toBe("San Francisco, CA");
    expect(ana.bio).toBe("Met at\nthe conference");
    expect(ana.birthday).toEqual({ year: 1990, month: 3, day: 14 });
    expect(ana.emails.map((e) => e.email)).toEqual([
      "ana.silva@example.com",
      "ana@work.example",
    ]);
    expect(ana.phones.map((p) => p.phone)).toEqual(["+41 79 123 45 67"]);
    expect(
      ana.socials.find((s) => s.platform === "linkedin")?.url
    ).toBe("https://www.linkedin.com/in/ana-silva");

    // Name-less contact keeps its identity through Full Name + email.
    expect(kenji.fullName).toBe("kenji@hoshi.example");
    expect(kenji.emails.map((e) => e.email)).toEqual(["kenji@hoshi.example"]);
    expect(kenji.birthday).toEqual({ year: null, month: 2, day: 29 });
  });

  it("informational columns are auto-ignored, not mis-imported", () => {
    const csvText = [...contactsCsvChunks(db)].join("");
    const { headers } = parseCsv(csvText);
    const mapping = guessMapping(headers);
    for (const col of ["Tags", "Groups", "Starred", "Archived", "Cadence Days", "Description (Markdown)"]) {
      expect(mapping[headers.indexOf(col)], col).toBe("ignore");
    }
  });
});
