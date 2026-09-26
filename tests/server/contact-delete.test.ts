import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// SPEC §3: a counting note is a touch for every contact it @-mentions, so
// deleting the contact it was filed under (which takes the note with it)
// must recompute those contacts — or they stay "recently touched" on the
// strength of a note that no longer exists.

vi.mock("@/lib/auth", () => ({ requireAuth: async () => ({ ok: true }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

let dataDir: string;
let rawDb: import("better-sqlite3").Database;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rolo-delete-"));
  process.env.ROLO_DATA_DIR = dataDir;
  const client = await import("@/db/client");
  rawDb = client.rawDb;
  migrate(client.db, { migrationsFolder: path.join(__dirname, "../../src/db/migrations") });
});

afterAll(() => {
  rawDb?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("deleteContactAction", () => {
  it("recomputes contacts the deleted contact's notes mentioned", async () => {
    const now = Date.now();
    const insert = rawDb.prepare(
      "INSERT INTO contacts (display_name, created_at, updated_at) VALUES (?, ?, ?)"
    );
    const ana = Number(insert.run("Ana Silva", now, now).lastInsertRowid);
    const ben = Number(insert.run("Ben Okafor", now, now).lastInsertRowid);
    const noteAt = now - 60_000;
    const noteId = Number(
      rawDb
        .prepare(
          "INSERT INTO notes (contact_id, body_md, counts_for_touch, created_at, updated_at) VALUES (?, 'lunch with @Ben', 1, ?, ?)"
        )
        .run(ana, noteAt, noteAt).lastInsertRowid
    );
    rawDb.prepare("INSERT INTO note_mentions (note_id, contact_id) VALUES (?, ?)").run(noteId, ben);
    const { recomputeContact } = await import("@/lib/cadence/recompute");
    recomputeContact(ben);
    const before = rawDb
      .prepare("SELECT last_interaction_at FROM contacts WHERE id = ?")
      .get(ben) as { last_interaction_at: number | null };
    expect(before.last_interaction_at).toBe(noteAt);

    const { deleteContactAction } = await import("@/server/contacts");
    await expect(deleteContactAction(ana, "Ana Silva")).rejects.toThrow("REDIRECT:/contacts");

    const after = rawDb
      .prepare("SELECT last_interaction_at FROM contacts WHERE id = ?")
      .get(ben) as { last_interaction_at: number | null };
    expect(after.last_interaction_at).toBeNull();
    expect(rawDb.prepare("SELECT count(*) AS n FROM notes").get()).toEqual({ n: 0 });
  });
});
