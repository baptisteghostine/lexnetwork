import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";

import { compileFilter } from "@/lib/filters/compile";
import type { FilterClause, FilterSet } from "@/lib/filters/types";

// The compiler's contract is "runs correctly against the real schema", so
// these tests execute compiled SQL on an in-memory DB built from the
// actual checked-in migrations.

const MIGRATIONS_DIR = path.join(__dirname, "../../../src/db/migrations");
const NOW = Date.UTC(2026, 7, 13, 12);
const DAY = 86_400_000;

let db: Database.Database;

function filter(...clauses: FilterClause[]): FilterSet {
  return { v: 1, clauses };
}

function run(f: FilterSet, catalog?: Parameters<typeof compileFilter>[1]["catalog"]) {
  const compiled = compileFilter(f, { now: NOW, catalog });
  const rows = db.prepare(compiled.sql).all(...compiled.params) as {
    id: number;
  }[];
  return { ids: rows.map((r) => r.id), warnings: compiled.warnings };
}

beforeAll(() => {
  db = new Database(":memory:");
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")
  ) as { entries: { tag: string }[] };
  for (const entry of journal.entries) {
    const sqlText = fs.readFileSync(
      path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
      "utf8"
    );
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      if (stmt.trim()) db.exec(stmt);
    }
  }

  const insertContact = db.prepare(`INSERT INTO contacts
    (id, display_name, title, company, starred, archived_at, cadence_days,
     last_interaction_at, next_touch_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // 1 Ada:    founder at Anthropic, ex-Google, starred, overdue, old friend
  // 2 Bruno:  engineer currently AT Google (contacts.company)
  // 3 Carla:  ex-Google via work_history, now at Stripe
  // 4 Dana:   current Googler via work_history is_current row
  // 5 Elias:  archived founder
  // 6 Fatima: no cadence, created recently, MIT education, linkedin
  insertContact.run(1, "Ada Lovelace", "Founder & CEO", "Anthropic", 1, null, 30, NOW - 100 * DAY, NOW - 5 * DAY, NOW - 400 * DAY, NOW);
  insertContact.run(2, "Bruno Marchetti", "Engineer", "Google", 0, null, null, NOW - 10 * DAY, null, NOW - 300 * DAY, NOW);
  insertContact.run(3, "Carla Jones", "Product Manager", "Stripe", 0, null, 91, NOW - 30 * DAY, NOW + 61 * DAY, NOW - 200 * DAY, NOW);
  insertContact.run(4, "Dana Kim", "Researcher", null, 0, null, null, null, null, NOW - 100 * DAY, NOW);
  insertContact.run(5, "Elias Berg", "Founder", "Bergwerk", 0, NOW - DAY, null, null, null, NOW - 500 * DAY, NOW);
  insertContact.run(6, "Fatima Noor", "Designer", "Figma", 0, null, null, NOW - 2 * DAY, null, NOW - 3 * DAY, NOW);

  const wh = db.prepare(`INSERT INTO work_history
    (contact_id, company, company_normalized, title, end_date, is_current, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'linkedin', ?)`);
  wh.run(1, "Google", "google", "PM", "2020-04", 0, NOW); // Ada: ex-Google
  wh.run(3, "Google LLC", "google", "APM", "2019", 0, NOW); // Carla: ex-Google
  wh.run(4, "Google", "google", "Researcher", null, 1, NOW); // Dana: current

  db.prepare(
    `INSERT INTO education (contact_id, school, degree, field, source, created_at)
     VALUES (6, 'MIT', 'BSc', 'Design', 'linkedin', ?)`
  ).run(NOW);

  db.prepare(`INSERT INTO tags (id, name, color, created_at) VALUES (1, 'investor', '#111111', ?)`).run(NOW);
  db.prepare(`INSERT INTO contact_tags (contact_id, tag_id, created_at) VALUES (3, 1, ?)`).run(NOW);

  db.prepare(`INSERT INTO groups (id, name, created_at) VALUES (1, 'Conferences', ?)`).run(NOW);
  db.prepare(`INSERT INTO groups (id, name, parent_id, created_at) VALUES (2, 'DevCon 2026', 1, ?)`).run(NOW);
  db.prepare(`INSERT INTO group_members (group_id, contact_id, created_at) VALUES (2, 6, ?)`).run(NOW);

  db.prepare(
    `INSERT INTO contact_socials (contact_id, platform, url, source, created_at)
     VALUES (6, 'linkedin', 'https://linkedin.com/in/fatima', 'user', ?)`
  ).run(NOW);

  db.prepare(`INSERT INTO custom_fields (id, name, kind, created_at) VALUES (1, 'Warmth', 'number', ?)`).run(NOW);
  db.prepare(`INSERT INTO custom_fields (id, name, kind, created_at) VALUES (2, 'Circles', 'multi_select', ?)`).run(NOW);
  const cfv = db.prepare(`INSERT INTO custom_field_values
    (custom_field_id, contact_id, value_text, value_number, value_date, value_json)
    VALUES (?, ?, ?, ?, ?, ?)`);
  cfv.run(1, 1, null, 9, null, null);
  cfv.run(1, 3, null, 4, null, null);
  cfv.run(2, 6, null, null, null, JSON.stringify(["design", "climbing"]));
});

describe("compileFilter — per-dimension (SPEC §7)", () => {
  it("no clauses → all active contacts (archived excluded by default)", () => {
    expect(run(filter()).ids).toEqual([1, 2, 3, 4, 6]); // name order; Elias archived
  });

  it("tag", () => {
    expect(run(filter({ dim: "tag", ids: [1] })).ids).toEqual([3]);
  });

  it("group includes descendants", () => {
    expect(run(filter({ dim: "group", ids: [1] })).ids).toEqual([6]);
  });

  it("lastInteraction before / after / never", () => {
    expect(
      run(filter({ dim: "lastInteraction", op: "before", at: NOW - 90 * DAY }))
        .ids
    ).toEqual([1]);
    expect(
      run(filter({ dim: "lastInteraction", op: "after", at: NOW - 5 * DAY })).ids
    ).toEqual([6]);
    expect(run(filter({ dim: "lastInteraction", op: "never" })).ids).toEqual([4]);
  });

  it("titleContains", () => {
    expect(run(filter({ dim: "titleContains", value: "founder" })).ids).toEqual([1]);
  });

  it("company current / past / any", () => {
    expect(
      run(filter({ dim: "company", mode: "current", value: "google" })).ids
    ).toEqual([2, 4]);
    expect(
      run(filter({ dim: "company", mode: "past", value: "google" })).ids
    ).toEqual([1, 3]);
    expect(
      run(filter({ dim: "company", mode: "any", value: "google" })).ids
    ).toEqual([1, 2, 3, 4]);
  });

  it("ex-Googlers: past Google, current elsewhere — excludes current Googlers (AC)", () => {
    const { ids } = run(filter({ dim: "company", mode: "ex", value: "google" }));
    expect(ids).toEqual([1, 3]); // Ada + Carla
    expect(ids).not.toContain(2); // Bruno works there (contacts.company)
    expect(ids).not.toContain(4); // Dana works there (work_history is_current)
  });

  it("educationContains", () => {
    expect(run(filter({ dim: "educationContains", value: "mit" })).ids).toEqual([6]);
  });

  it("hasLinkedin true / false", () => {
    expect(run(filter({ dim: "hasLinkedin", value: true })).ids).toEqual([6]);
    expect(run(filter({ dim: "hasLinkedin", value: false })).ids).toEqual([1, 2, 3, 4]);
  });

  it("createdAt range", () => {
    expect(
      run(filter({ dim: "createdAt", from: NOW - 10 * DAY })).ids
    ).toEqual([6]);
  });

  it("starred / archived / cadence / dueStatus", () => {
    expect(run(filter({ dim: "starred", value: true })).ids).toEqual([1]);
    expect(run(filter({ dim: "archived", value: true })).ids).toEqual([5]);
    expect(run(filter({ dim: "cadence", value: "set" })).ids).toEqual([1, 3]);
    expect(run(filter({ dim: "dueStatus", value: "due" })).ids).toEqual([1]);
    expect(run(filter({ dim: "dueStatus", value: "overdue" })).ids).toEqual([1]);
    expect(run(filter({ dim: "dueStatus", value: "not_due" })).ids).toEqual([2, 3, 4, 6]);
  });

  it("customField number gt and multi_select includes", () => {
    expect(
      run(filter({ dim: "customField", fieldId: 1, op: "gt", value: 5 })).ids
    ).toEqual([1]);
    expect(
      run(
        filter({ dim: "customField", fieldId: 2, op: "includes", value: "design" })
      ).ids
    ).toEqual([6]);
  });

  it("AND across dimensions", () => {
    expect(
      run(
        filter(
          { dim: "company", mode: "ex", value: "google" },
          { dim: "starred", value: true }
        )
      ).ids
    ).toEqual([1]);
  });

  it("canonical view: founders not spoken to in 90 days", () => {
    expect(
      run(
        filter(
          { dim: "titleContains", value: "founder" },
          { dim: "lastInteraction", op: "before", at: NOW - 90 * DAY }
        )
      ).ids
    ).toEqual([1]);
  });

  it("dangling tag → warning, remaining filter still runs", () => {
    const { ids, warnings } = run(
      filter({ dim: "tag", ids: [999] }, { dim: "starred", value: true }),
      { tagIds: new Set([1]) }
    );
    expect(warnings.some((w) => w.includes("tag:999"))).toBe(true);
    expect(ids).toEqual([1]); // starred clause still applied
  });

  it("locationRadius without a geocoder is skipped with a warning, not empty", () => {
    const { ids, warnings } = run(
      filter({ dim: "locationRadius", lat: 40.7, lng: -74, km: 50 })
    );
    expect(warnings.some((w) => w.includes("geocoder"))).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("special characters in LIKE values cannot wildcard-match", () => {
    expect(run(filter({ dim: "titleContains", value: "%" })).ids).toEqual([]);
  });
});

describe("lastInteraction before + includeNever", () => {
  it("includes never-contacted people when the flag is on", () => {
    // Ada (1): last interaction 100d ago. Bruno (2): 10d ago (fresh).
    // Dana (4): never contacted (last_interaction_at NULL).
    const without = run({
      v: 1,
      clauses: [{ dim: "lastInteraction", op: "before", at: NOW - 90 * DAY }],
    }).ids;
    expect(without).toContain(1);
    expect(without).not.toContain(4);

    const withNever = run({
      v: 1,
      clauses: [
        { dim: "lastInteraction", op: "before", at: NOW - 90 * DAY, includeNever: true },
      ],
    }).ids;
    expect(withNever).toContain(1);
    expect(withNever).toContain(4);
    expect(withNever).not.toContain(2);
  });
});
