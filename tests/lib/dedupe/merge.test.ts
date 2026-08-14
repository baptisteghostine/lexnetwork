import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  defaultDecisions,
  mergeContacts,
  undoMerge,
} from "@/lib/dedupe/merge";

// The merge engine's contract is "repoints everything against the real
// schema and undoes byte-identically", so these tests run it on an
// in-memory DB built from the actual checked-in migrations (same pattern
// as the filter-compiler suite).

const MIGRATIONS_DIR = path.join(__dirname, "../../../src/db/migrations");
const NOW = Date.UTC(2026, 7, 13, 12);

let db: Database.Database;
let ids: { winner: number; loser: number; tagShared: number; tagLoser: number; group: number; other: number };

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

function insertContact(over: Record<string, unknown>): number {
  const base = {
    first_name: null,
    last_name: null,
    display_name: "x",
    title: null,
    company: null,
    location: null,
    bio: null,
    description_md: null,
    starred: 0,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
  const cols = Object.keys(base);
  return Number(
    db
      .prepare(
        `INSERT INTO contacts (${cols.join(",")}) VALUES (${cols.map((c) => `@${c}`).join(",")})`
      )
      .run(base).lastInsertRowid
  );
}

function count(sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  db.pragma("foreign_keys = ON");

  const winner = insertContact({
    first_name: "Katherine",
    last_name: "Johnson",
    display_name: "Katherine Johnson",
    company: "NASA",
    starred: 0,
  });
  const loser = insertContact({
    first_name: "Kate",
    last_name: "Johnson",
    display_name: "Kate Johnson",
    title: "Research Mathematician",
    company: "NACA",
    starred: 1,
    cadence_days: 30,
    cadence_assigned_at: NOW - 10_000,
  });
  const other = insertContact({ display_name: "Third Person" });

  const email = db.prepare(
    `INSERT INTO contact_emails (contact_id, email, email_normalized, priority, source, created_at)
     VALUES (?, ?, ?, ?, 'user', ?)`
  );
  email.run(winner, "kj@nasa.gov", "kj@nasa.gov", 0, NOW);
  email.run(loser, "kj@nasa.gov", "kj@nasa.gov", 0, NOW); // conflict — dropped
  email.run(loser, "kate@naca.gov", "kate@naca.gov", 1, NOW); // moves

  db.prepare(
    `INSERT INTO interactions (contact_id, kind, occurred_at, source, counts_for_touch, created_at)
     VALUES (?, 'manual', ?, 'user', 1, ?)`
  ).run(loser, NOW - 5_000, NOW);
  db.prepare(
    `INSERT INTO notes (contact_id, body_md, counts_for_touch, created_at, updated_at)
     VALUES (?, 'met at conference', 0, ?, ?)`
  ).run(loser, NOW, NOW);

  const tagShared = Number(
    db
      .prepare("INSERT INTO tags (name, color, created_at) VALUES ('vip','red',?)")
      .run(NOW).lastInsertRowid
  );
  const tagLoser = Number(
    db
      .prepare("INSERT INTO tags (name, color, created_at) VALUES ('math','blue',?)")
      .run(NOW).lastInsertRowid
  );
  const ct = db.prepare(
    "INSERT INTO contact_tags (contact_id, tag_id, created_at) VALUES (?,?,?)"
  );
  ct.run(winner, tagShared, NOW);
  ct.run(loser, tagShared, NOW); // conflict — dropped
  ct.run(loser, tagLoser, NOW); // moves

  const group = Number(
    db
      .prepare("INSERT INTO groups (name, created_at) VALUES ('scientists',?)")
      .run(NOW).lastInsertRowid
  );
  db.prepare(
    "INSERT INTO group_members (group_id, contact_id, created_at) VALUES (?,?,?)"
  ).run(group, loser, NOW);

  db.prepare(
    `INSERT INTO contact_relationships (contact_a_id, contact_b_id, label, directed, created_at)
     VALUES (?,?,?,0,?)`
  ).run(Math.min(loser, other), Math.max(loser, other), "colleague", NOW);

  db.prepare(
    `INSERT INTO duplicate_candidates (contact_a_id, contact_b_id, score, reasons_json, status, created_at)
     VALUES (?,?,?,?, 'open', ?)`
  ).run(
    Math.min(winner, loser),
    Math.max(winner, loser),
    0.85,
    '["jw:1.00"]',
    NOW
  );

  ids = { winner, loser, tagShared, tagLoser, group, other };
});

function loserRow(): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM contacts WHERE id = ?").get(ids.loser) as
    | Record<string, unknown>
    | undefined;
}

describe("mergeContacts", () => {
  it("repoints every timeline item and the loser's id is gone", () => {
    mergeContacts(db, { winnerId: ids.winner, loserId: ids.loser, now: NOW });

    expect(loserRow()).toBeUndefined();
    expect(
      count("SELECT COUNT(*) n FROM interactions WHERE contact_id = ?", ids.winner)
    ).toBe(1);
    expect(
      count("SELECT COUNT(*) n FROM notes WHERE contact_id = ?", ids.winner)
    ).toBe(1);
    expect(
      count("SELECT COUNT(*) n FROM interactions WHERE contact_id = ?", ids.loser)
    ).toBe(0);
  });

  it("unions multi-value fields, dropping exact duplicates", () => {
    mergeContacts(db, { winnerId: ids.winner, loserId: ids.loser, now: NOW });
    const emails = db
      .prepare(
        "SELECT email_normalized FROM contact_emails WHERE contact_id = ? ORDER BY email_normalized"
      )
      .all(ids.winner) as { email_normalized: string }[];
    expect(emails.map((e) => e.email_normalized)).toEqual([
      "kate@naca.gov",
      "kj@nasa.gov",
    ]);
    const tags = db
      .prepare("SELECT tag_id FROM contact_tags WHERE contact_id = ? ORDER BY tag_id")
      .all(ids.winner) as { tag_id: number }[];
    expect(tags.map((t) => t.tag_id).sort()).toEqual(
      [ids.tagShared, ids.tagLoser].sort()
    );
  });

  it("defaults: winner's non-empty fields win, empty ones adopt the loser's", () => {
    const winner = db.prepare("SELECT * FROM contacts WHERE id=?").get(ids.winner) as Record<string, unknown>;
    const loser = loserRow()!;
    const d = defaultDecisions(winner, loser);
    expect(d.company).toBe("winner");
    expect(d.title).toBe("loser"); // winner has no title
    expect(d.cadence).toBe("loser"); // winner has no cadence

    mergeContacts(db, { winnerId: ids.winner, loserId: ids.loser, now: NOW });
    const after = db.prepare("SELECT * FROM contacts WHERE id=?").get(ids.winner) as Record<string, unknown>;
    expect(after.company).toBe("NASA");
    expect(after.title).toBe("Research Mathematician");
    expect(after.cadence_days).toBe(30);
    expect(after.starred).toBe(1); // star survives from either side
  });

  it("honours explicit decisions over defaults", () => {
    mergeContacts(db, {
      winnerId: ids.winner,
      loserId: ids.loser,
      decisions: { company: "loser" },
      now: NOW,
    });
    const after = db.prepare("SELECT company FROM contacts WHERE id=?").get(ids.winner) as { company: string };
    expect(after.company).toBe("NACA");
  });

  it("repoints relationships to the winner, canonicalized", () => {
    mergeContacts(db, { winnerId: ids.winner, loserId: ids.loser, now: NOW });
    const rel = db
      .prepare("SELECT * FROM contact_relationships")
      .all() as Record<string, unknown>[];
    expect(rel).toHaveLength(1);
    const [a, b] = [rel[0].contact_a_id, rel[0].contact_b_id];
    expect([a, b]).toEqual([
      Math.min(ids.winner, ids.other),
      Math.max(ids.winner, ids.other),
    ]);
  });

  it("recomputes the winner's derived columns from the merged timeline", () => {
    mergeContacts(db, { winnerId: ids.winner, loserId: ids.loser, now: NOW });
    const after = db
      .prepare("SELECT last_interaction_at, next_touch_at FROM contacts WHERE id=?")
      .get(ids.winner) as { last_interaction_at: number; next_touch_at: number };
    expect(after.last_interaction_at).toBe(NOW - 5_000);
    // Cadence adopted from loser (30d) — due 30 days after last interaction.
    expect(after.next_touch_at).toBe(NOW - 5_000 + 30 * 86_400_000);
  });
});

describe("undoMerge", () => {
  it("restores both contacts byte-identical on profile fields and repoints back", () => {
    const winnerBefore = db.prepare("SELECT * FROM contacts WHERE id=?").get(ids.winner) as Record<string, unknown>;
    const loserBefore = loserRow()!;

    const { logId } = mergeContacts(db, {
      winnerId: ids.winner,
      loserId: ids.loser,
      now: NOW,
    });
    const result = undoMerge(db, logId, NOW + 1000);
    expect(result).toEqual({ ok: true });

    const PROFILE = [
      "first_name",
      "last_name",
      "title",
      "company",
      "location",
      "bio",
      "description_md",
      "birthday_month",
      "birthday_day",
      "birthday_year",
      "photo_path",
      "starred",
      "cadence_days",
      "cadence_assigned_at",
      "display_name",
    ];
    const winnerAfter = db.prepare("SELECT * FROM contacts WHERE id=?").get(ids.winner) as Record<string, unknown>;
    const loserAfter = loserRow()!;
    for (const col of PROFILE) {
      expect(winnerAfter[col]).toEqual(winnerBefore[col]);
      expect(loserAfter[col]).toEqual(loserBefore[col]);
    }

    // Children back where they were.
    expect(
      count("SELECT COUNT(*) n FROM interactions WHERE contact_id=?", ids.loser)
    ).toBe(1);
    expect(
      count("SELECT COUNT(*) n FROM interactions WHERE contact_id=?", ids.winner)
    ).toBe(0);
    expect(
      count("SELECT COUNT(*) n FROM contact_emails WHERE contact_id=?", ids.loser)
    ).toBe(2);
    expect(
      count("SELECT COUNT(*) n FROM contact_tags WHERE contact_id=?", ids.loser)
    ).toBe(2);
    expect(
      count("SELECT COUNT(*) n FROM contact_tags WHERE contact_id=? AND tag_id=?", ids.winner, ids.tagLoser)
    ).toBe(0);
    expect(
      count("SELECT COUNT(*) n FROM group_members WHERE contact_id=?", ids.loser)
    ).toBe(1);
    // The open duplicate pair is back in the queue.
    expect(
      count(
        "SELECT COUNT(*) n FROM duplicate_candidates WHERE status='open' AND contact_a_id=? AND contact_b_id=?",
        Math.min(ids.winner, ids.loser),
        Math.max(ids.winner, ids.loser)
      )
    ).toBe(1);
    // Relationship points at the loser again.
    const rel = db.prepare("SELECT * FROM contact_relationships").all() as Record<string, unknown>[];
    expect(rel).toHaveLength(1);
    expect([rel[0].contact_a_id, rel[0].contact_b_id]).toContain(ids.loser);
  });

  it("refuses after a conflicting edit to the merged contact, with an explanation", () => {
    const { logId } = mergeContacts(db, {
      winnerId: ids.winner,
      loserId: ids.loser,
      now: NOW,
    });
    db.prepare("UPDATE contacts SET company='Retired' WHERE id=?").run(ids.winner);

    const result = undoMerge(db, logId, NOW + 1000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("company");
    // Nothing was touched.
    expect(loserRow()).toBeUndefined();
  });

  it("does not block undo on new activity (interactions are not edits)", () => {
    const { logId } = mergeContacts(db, {
      winnerId: ids.winner,
      loserId: ids.loser,
      now: NOW,
    });
    db.prepare(
      `INSERT INTO interactions (contact_id, kind, occurred_at, source, counts_for_touch, created_at)
       VALUES (?, 'manual', ?, 'user', 1, ?)`
    ).run(ids.winner, NOW + 500, NOW + 500);

    expect(undoMerge(db, logId, NOW + 1000)).toEqual({ ok: true });
    // The new interaction stays with the winner.
    expect(
      count("SELECT COUNT(*) n FROM interactions WHERE contact_id=?", ids.winner)
    ).toBe(1);
  });

  it("refuses a second undo of the same merge", () => {
    const { logId } = mergeContacts(db, {
      winnerId: ids.winner,
      loserId: ids.loser,
      now: NOW,
    });
    expect(undoMerge(db, logId, NOW + 1000).ok).toBe(true);
    const again = undoMerge(db, logId, NOW + 2000);
    expect(again.ok).toBe(false);
  });
});

describe("merge — dismissal memory transfer", () => {
  it("a dismissal involving the loser survives as (winner, other)", () => {
    const [a, b] =
      ids.loser < ids.other ? [ids.loser, ids.other] : [ids.other, ids.loser];
    db.prepare(
      `INSERT INTO duplicate_candidates (contact_a_id, contact_b_id, score, reasons_json, status, created_at, resolved_at)
       VALUES (?, ?, 0.9, '["jw:0.93"]', 'dismissed', ?, ?)`
    ).run(a, b, NOW, NOW);

    mergeContacts(db, { winnerId: ids.winner, loserId: ids.loser, now: NOW });

    const [wa, wb] =
      ids.winner < ids.other
        ? [ids.winner, ids.other]
        : [ids.other, ids.winner];
    const row = db
      .prepare(
        "SELECT status FROM duplicate_candidates WHERE contact_a_id = ? AND contact_b_id = ?"
      )
      .get(wa, wb) as { status: string } | undefined;
    expect(row?.status).toBe("dismissed");
  });
});

describe("undo — deleted referents", () => {
  it("undo succeeds when a tag assigned to the loser was deleted post-merge", () => {
    const { logId } = mergeContacts(db, {
      winnerId: ids.winner,
      loserId: ids.loser,
      now: NOW,
    });
    // Owner deletes the loser-only tag after the merge.
    db.prepare("DELETE FROM tags WHERE id = ?").run(ids.tagLoser);

    const result = undoMerge(db, logId, NOW + 1000);
    expect(result.ok).toBe(true);
    // The loser is back; the orphaned tag assignment is skipped, not fatal.
    expect(count("SELECT count(*) n FROM contacts WHERE id = ?", ids.loser)).toBe(1);
    expect(
      count(
        "SELECT count(*) n FROM contact_tags WHERE contact_id = ? AND tag_id = ?",
        ids.loser,
        ids.tagLoser
      )
    ).toBe(0);
  });
});
