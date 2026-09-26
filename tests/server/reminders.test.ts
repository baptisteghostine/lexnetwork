import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// SPEC §4: editing a reminder must never re-fire what already fired or
// replay a recurring series from its start. Runs the real server actions
// against a migrated database in a temp directory.

vi.mock("@/lib/auth", () => ({ requireAuth: async () => ({ ok: true }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const DAY = 24 * 60 * 60 * 1000;
let dataDir: string;
let rawDb: import("better-sqlite3").Database;
let actions: typeof import("@/server/reminders");
let fire: typeof import("@/lib/reminders/fire");

type Row = {
  id: number;
  title: string;
  due_at: number;
  rrule: string | null;
  series_id: number | null;
  fired_at: number | null;
  snoozed_until: number | null;
  completed_at: number | null;
};

function rows(seriesId: number): Row[] {
  return rawDb
    .prepare("SELECT * FROM reminders WHERE series_id = ? ORDER BY due_at")
    .all(seriesId) as Row[];
}
function row(id: number): Row {
  return rawDb.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as Row;
}
function payload(p: Record<string, unknown>): FormData {
  const fd = new FormData();
  fd.set("payload", JSON.stringify(p));
  return fd;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rolo-reminders-"));
  process.env.ROLO_DATA_DIR = dataDir;
  const client = await import("@/db/client");
  rawDb = client.rawDb;
  migrate(client.db, { migrationsFolder: path.join(__dirname, "../../src/db/migrations") });
  actions = await import("@/server/reminders");
  fire = await import("@/lib/reminders/fire");
});

afterAll(() => {
  rawDb?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("editing a recurring reminder", () => {
  it("a title-only edit keeps the live occurrence and does not replay the series", async () => {
    // A weekly rule that started 38 weeks ago: its past occurrences fired
    // and were completed; one live occurrence is due in three days.
    const now = Date.now();
    const start = now - 38 * 7 * DAY;
    const res = await actions.createReminderAction(
      {},
      payload({ title: "Call mum", dueAt: start, rrule: "FREQ=WEEKLY", contactId: null })
    );
    expect(res.error).toBeUndefined();
    const definer = rawDb
      .prepare("SELECT id FROM reminders WHERE rrule IS NOT NULL ORDER BY id DESC")
      .get() as { id: number };
    // The first occurrence materialized at the start; stand in for the
    // months of firing by completing it and placing the live one ahead.
    const first = rows(definer.id)[0];
    rawDb
      .prepare("UPDATE reminders SET fired_at = ?, completed_at = ? WHERE id = ?")
      .run(first.due_at, first.due_at, first.id);
    const liveDue = now + 3 * DAY;
    rawDb
      .prepare(
        "INSERT INTO reminders (title, due_at, series_id, created_at, updated_at) VALUES ('Call mum', ?, ?, ?, ?)"
      )
      .run(liveDue, definer.id, now, now);

    // The form round-trips the definer's own start (at minute precision).
    const edited = await actions.updateReminderAction(
      definer.id,
      payload({
        title: "Call mum (Sunday)",
        dueAt: Math.floor(start / 60_000) * 60_000,
        rrule: "FREQ=WEEKLY",
        contactId: null,
      })
    );
    expect(edited.error).toBeUndefined();

    const live = rows(definer.id).filter((r) => r.fired_at === null && r.completed_at === null);
    expect(live).toHaveLength(1);
    expect(live[0].due_at).toBe(liveDue);
    expect(live[0].title).toBe("Call mum (Sunday)");
    expect(row(definer.id).due_at).toBe(start);
    // Nothing is due now — the sweep fires nothing.
    expect(fire.fireDueReminders(now)).toBe(0);
  });

  it("a schedule change restarts the series from today, not from the old start", async () => {
    const now = Date.now();
    const start = now - 10 * 7 * DAY;
    await actions.createReminderAction(
      {},
      payload({ title: "Water plants", dueAt: start, rrule: "FREQ=WEEKLY", contactId: null })
    );
    const definer = rawDb
      .prepare("SELECT id FROM reminders WHERE rrule IS NOT NULL ORDER BY id DESC")
      .get() as { id: number };
    const edited = await actions.updateReminderAction(
      definer.id,
      payload({ title: "Water plants", dueAt: start, rrule: "FREQ=DAILY", contactId: null })
    );
    expect(edited.error).toBeUndefined();
    const live = rows(definer.id).filter((r) => r.fired_at === null && r.completed_at === null);
    expect(live).toHaveLength(1);
    expect(live[0].due_at).toBeGreaterThanOrEqual(now);
    expect(live[0].due_at).toBeLessThanOrEqual(now + DAY);
    expect(row(definer.id).rrule).toBe("FREQ=DAILY");
  });
});

describe("editing a one-off reminder", () => {
  it("a title-only edit does not re-fire a reminder whose due time carries seconds", async () => {
    // Follow-up reminders are created as now + N days, seconds included.
    const now = Date.now();
    const dueAt = now - 5 * 60_000 + 17_345;
    const id = (
      rawDb
        .prepare(
          "INSERT INTO reminders (title, due_at, fired_at, created_at, updated_at) VALUES ('Send the deck', ?, ?, ?, ?)"
        )
        .run(dueAt, now - 60_000, now, now).lastInsertRowid as number
    );
    const res = await actions.updateReminderAction(
      id,
      payload({
        title: "Send the deck to Ana",
        dueAt: Math.floor(dueAt / 60_000) * 60_000,
        rrule: "",
        contactId: null,
      })
    );
    expect(res.error).toBeUndefined();
    const after = row(id);
    expect(after.title).toBe("Send the deck to Ana");
    expect(after.fired_at).not.toBeNull();
    expect(after.due_at).toBe(dueAt);
    expect(fire.fireDueReminders(now)).toBe(0);
  });

  it("moving the due time clears the fired flag so it fires again", async () => {
    const now = Date.now();
    const id = (
      rawDb
        .prepare(
          "INSERT INTO reminders (title, due_at, fired_at, created_at, updated_at) VALUES ('Ping Marc', ?, ?, ?, ?)"
        )
        .run(now - DAY, now - DAY, now, now).lastInsertRowid as number
    );
    const res = await actions.updateReminderAction(
      id,
      payload({ title: "Ping Marc", dueAt: now - 60_000, rrule: "", contactId: null })
    );
    expect(res.error).toBeUndefined();
    expect(row(id).fired_at).toBeNull();
    expect(fire.fireDueReminders(now)).toBe(1);
  });
});
