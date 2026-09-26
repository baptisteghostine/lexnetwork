import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// SPEC §8/§2: re-uploading a LinkedIn export is the monthly ritual, and it
// must only add or update — never duplicate a contact, an interaction or
// a work-history row, never invent a job change from identical data —
// while backfilling what an older import lacked (snippets, and since
// 2026-09-26 full message bodies). Runs the real import core against a
// migrated database in a temp directory: the same code path the upload
// takes, minus the ZIP unpacking.

const FIXTURES = path.join(__dirname, "../fixtures/linkedin");
let dataDir: string;
let rawDb: import("better-sqlite3").Database;
let run: (
  messages: import("@/lib/imports/linkedin").LinkedInMessage[],
  fileName: string
) => ReturnType<typeof import("@/server/linkedin-import").executeLinkedInRows>;

function counts() {
  const q = (sql: string) => (rawDb.prepare(sql).get() as { n: number }).n;
  return {
    contacts: q("SELECT count(*) n FROM contacts"),
    interactions: q("SELECT count(*) n FROM interactions"),
    withSnippet: q("SELECT count(*) n FROM interactions WHERE kind='message' AND title IS NOT NULL"),
    withBody: q("SELECT count(*) n FROM interactions WHERE kind='message' AND meta IS NOT NULL"),
    changes: q("SELECT count(*) n FROM contact_changes"),
    work: q("SELECT count(*) n FROM work_history"),
    socials: q("SELECT count(*) n FROM contact_socials"),
    emails: q("SELECT count(*) n FROM contact_emails"),
  };
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rolo-reimport-"));
  process.env.ROLO_DATA_DIR = dataDir;
  // The DB client reads the env at import time, so everything that touches
  // it is imported here, after the env is set.
  const client = await import("@/db/client");
  rawDb = client.rawDb;
  migrate(client.db, { migrationsFolder: path.join(__dirname, "../../src/db/migrations") });
  const { parseConnections, parseProfileOwnerName } = await import("@/lib/imports/linkedin");
  const { executeLinkedInRows } = await import("@/server/linkedin-import");
  const read = (f: string) => fs.readFileSync(path.join(FIXTURES, f), "utf8");
  const ownerName = parseProfileOwnerName(read("Profile.csv"));
  const connections = parseConnections(read("Connections.csv"));
  run = (messages, fileName) =>
    executeLinkedInRows({ connections, messages, ownerName, runKind: "linkedin_import", fileName });
});

afterAll(() => {
  rawDb?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("re-importing the same LinkedIn export", () => {
  it("adds nothing twice and backfills snippets and bodies onto older rows", async () => {
    const { parseMessages, parseProfileOwnerName } = await import("@/lib/imports/linkedin");
    const ownerName = parseProfileOwnerName(fs.readFileSync(path.join(FIXTURES, "Profile.csv"), "utf8"));
    const messages = parseMessages(fs.readFileSync(path.join(FIXTURES, "messages.csv"), "utf8"), ownerName);

    // An import from before message content was stored.
    const first = run(messages.map((m) => ({ ...m, snippet: null, body: null })), "old.zip");
    const c1 = counts();
    expect(first.report.stats.new).toBe(4);
    expect(c1).toMatchObject({ contacts: 4, interactions: 3, withSnippet: 0, withBody: 0, changes: 0 });

    // The same export again, with today's parser.
    const second = run(messages, "again.zip");
    const c2 = counts();
    expect(second.report.stats).toMatchObject({ new: 0, updated: 0, unchanged: 4, conflicts: 0, errors: 0 });
    expect(second.report.jobChanges).toHaveLength(0);
    expect(c2).toEqual({ ...c1, withSnippet: 3, withBody: 3 });

    // And a third time: nothing at all moves.
    const third = run(messages, "third.zip");
    expect(third.report.jobChanges).toHaveLength(0);
    expect(third.report.messagesLinked).toBe(0);
    expect(counts()).toEqual(c2);

    const body = rawDb.prepare("SELECT meta FROM interactions WHERE kind='message' LIMIT 1").get() as { meta: string };
    expect(JSON.parse(body.meta)).toHaveProperty("body");
  });
});

describe("a thread logged from the extension, then the ZIP", () => {
  it("folds minute-precision rows into the export's second-precision ones — no duplicates either way", async () => {
    const { parseMessages, parseProfileOwnerName } = await import("@/lib/imports/linkedin");
    const { insertLinkedInMessages } = await import("@/server/linkedin-import");
    const ownerName = parseProfileOwnerName(fs.readFileSync(path.join(FIXTURES, "Profile.csv"), "utf8"));
    const messages = parseMessages(fs.readFileSync(path.join(FIXTURES, "messages.csv"), "utf8"), ownerName);
    const before = counts();
    const ana = rawDb.prepare("SELECT id FROM contacts WHERE display_name = 'Ana Silva'").get() as { id: number };
    const thread = messages.filter((m) => m.conversationId === "conv-001");
    expect(thread.length).toBeGreaterThan(0);

    // The messaging view knows the same messages to the minute, in the
    // browser's clock, with the thread's URL segment as the id.
    const minute = (ms: number) => Math.floor(ms / 60_000) * 60_000;
    const logged = insertLinkedInMessages(
      ana.id,
      "2-ZmFrZQ==",
      thread.map((m) => ({ direction: m.direction, occurredAt: minute(m.occurredAt), snippet: m.snippet, body: m.body })),
      null
    );
    expect(logged).toBe(0); // the export was imported first: nothing new
    expect(counts()).toEqual(before);

    // The other order: a thread logged before the export existed in Rolo.
    rawDb.prepare("DELETE FROM interactions WHERE contact_id = ?").run(ana.id);
    const fresh = insertLinkedInMessages(
      ana.id,
      "2-ZmFrZQ==",
      thread.map((m) => ({ direction: m.direction, occurredAt: minute(m.occurredAt), snippet: m.snippet, body: null })),
      null
    );
    expect(fresh).toBe(thread.length);
    run(messages, "after-thread.zip");
    expect(counts()).toEqual(before);
    const rows = rawDb
      .prepare("SELECT occurred_at, meta FROM interactions WHERE contact_id = ? ORDER BY occurred_at")
      .all(ana.id) as { occurred_at: number; meta: string | null }[];
    // The precise times won, and the bodies the thread lacked were filled in.
    expect(rows.map((r) => r.occurred_at)).toEqual(thread.map((m) => m.occurredAt).sort((a, b) => a - b));
    expect(rows.every((r) => r.meta !== null)).toBe(true);
    // And again: still nothing moves.
    run(messages, "after-thread-2.zip");
    expect(counts()).toEqual(before);
  });
});
