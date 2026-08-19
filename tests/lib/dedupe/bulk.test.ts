import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { bulkMergePairs, pickBulkWinner } from "@/lib/dedupe/bulk";
import { undoMerge } from "@/lib/dedupe/merge";

// SPEC §10 bulk merge, against the real migrations (same pattern as the
// single-merge suite): richer contact wins, ties go older, chained pairs
// skip with a reason, every merge stays individually undoable.

const MIGRATIONS_DIR = path.join(__dirname, "../../../src/db/migrations");
const NOW = Date.UTC(2026, 7, 15, 12);

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

function insertContact(over: Record<string, unknown> = {}): number {
  const base = {
    display_name: "x",
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
  const cols = Object.keys(base);
  return Number(
    db
      .prepare(
        `INSERT INTO contacts (${cols.join(",")}) VALUES (${cols
          .map((c) => `@${c}`)
          .join(",")})`
      )
      .run(base).lastInsertRowid
  );
}

function insertEmail(contactId: number, email: string): void {
  db.prepare(
    `INSERT INTO contact_emails (contact_id, email, email_normalized, priority, source, created_at)
     VALUES (?, ?, ?, 0, 'user', ?)`
  ).run(contactId, email, email.toLowerCase(), NOW);
}

function insertPair(aId: number, bId: number, score = 1): number {
  const [a, b] = aId < bId ? [aId, bId] : [bId, aId];
  return Number(
    db
      .prepare(
        `INSERT INTO duplicate_candidates (contact_a_id, contact_b_id, score, reasons_json, status, created_at)
         VALUES (?, ?, ?, '["email_match"]', 'open', ?)`
      )
      .run(a, b, score, NOW).lastInsertRowid
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});

describe("pickBulkWinner", () => {
  it("the contact with more filled data wins", () => {
    const sparse = insertContact({ display_name: "Bob" });
    const rich = insertContact({
      display_name: "Robert Smith",
      first_name: "Robert",
      last_name: "Smith",
      title: "CTO",
      company: "Globex",
    });
    insertEmail(rich, "bob@globex.example");
    expect(pickBulkWinner(db, sparse, rich)).toEqual({
      winnerId: rich,
      loserId: sparse,
    });
    // Argument order must not matter.
    expect(pickBulkWinner(db, rich, sparse)).toEqual({
      winnerId: rich,
      loserId: sparse,
    });
  });

  it("child rows count as data, not just profile fields", () => {
    const withEmail = insertContact({ display_name: "A" });
    insertEmail(withEmail, "a@example.com");
    const bare = insertContact({ display_name: "B" });
    expect(pickBulkWinner(db, bare, withEmail).winnerId).toBe(withEmail);
  });

  it("tie goes to the older contact", () => {
    const older = insertContact({ display_name: "A", created_at: NOW - 1000 });
    const newer = insertContact({ display_name: "B", created_at: NOW });
    expect(pickBulkWinner(db, newer, older)).toEqual({
      winnerId: older,
      loserId: newer,
    });
  });
});

describe("bulkMergePairs", () => {
  it("merges every selected pair with default decisions", () => {
    const a1 = insertContact({ display_name: "Ana Silva", title: "PM" });
    const a2 = insertContact({ display_name: "Ana S." });
    const b1 = insertContact({ display_name: "Kenji W.", company: "Hoshi" });
    const b2 = insertContact({ display_name: "Kenji" });
    insertEmail(a2, "ana@example.com");
    insertEmail(b2, "kenji@example.com");
    const p1 = insertPair(a1, a2);
    const p2 = insertPair(b1, b2);

    const result = bulkMergePairs(db, [p1, p2]);
    expect(result.merged).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    // One contact per pair survives, each with the union of emails.
    const remaining = db.prepare("SELECT count(*) AS n FROM contacts").get() as {
      n: number;
    };
    expect(remaining.n).toBe(2);
    const emails = db
      .prepare("SELECT count(*) AS n FROM contact_emails")
      .get() as { n: number };
    expect(emails.n).toBe(2);
  });

  it("a chained pair is skipped with a reason, never silently re-routed", () => {
    // A–B and B–C both selected: after A absorbs B, the B–C pair's row
    // cascades away with B.
    const a = insertContact({ display_name: "A", title: "x", company: "y" });
    const b = insertContact({ display_name: "B" });
    const c = insertContact({ display_name: "C" });
    const pAB = insertPair(a, b);
    const pBC = insertPair(b, c);

    const result = bulkMergePairs(db, [pAB, pBC]);
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0]).toMatchObject({ winnerId: a, loserId: b });
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].pairId).toBe(pBC);
    expect(result.skipped[0].reason).toMatch(/re-scan/);
    // C is untouched.
    expect(db.prepare("SELECT id FROM contacts WHERE id = ?").get(c)).toBeTruthy();
  });

  it("non-open pairs are skipped", () => {
    const a = insertContact({ display_name: "A" });
    const b = insertContact({ display_name: "B" });
    const pairId = insertPair(a, b);
    db.prepare(
      "UPDATE duplicate_candidates SET status = 'dismissed', resolved_at = ? WHERE id = ?"
    ).run(NOW, pairId);
    const result = bulkMergePairs(db, [pairId]);
    expect(result.merged).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("dismissed");
  });

  it("each bulk merge is individually undoable", () => {
    // Realistic rows: the app always derives display_name from name
    // fields, and the merge re-derives it — a display_name with null
    // first/last would come back "Unnamed".
    const rich = insertContact({
      display_name: "Rich",
      first_name: "Rich",
      title: "CEO",
      bio: "b",
    });
    const poor = insertContact({ display_name: "Poor", first_name: "Poor" });
    const pairId = insertPair(rich, poor);
    const result = bulkMergePairs(db, [pairId]);
    expect(result.merged).toHaveLength(1);

    const undone = undoMerge(db, result.merged[0].logId);
    expect(undone.ok).toBe(true);
    const names = db
      .prepare("SELECT display_name FROM contacts ORDER BY id")
      .all() as { display_name: string }[];
    expect(names.map((n) => n.display_name)).toEqual(["Rich", "Poor"]);
  });
});
