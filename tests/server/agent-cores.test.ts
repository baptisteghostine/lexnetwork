import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// SPEC §14, Phase 13: the cores the agent connector will call, run
// against a real migrated database with no session at all. `requireAuth`
// and `revalidatePath` are mocked to throw — a core that reached for the
// cookie or for a page cache would fail here, which is the point: a route
// handler has neither.

vi.mock("@/lib/auth", () => ({
  requireAuth: async () => {
    throw new Error("a core asked for a session");
  },
  isAuthenticated: async () => {
    throw new Error("a core asked for a session");
  },
}));
vi.mock("next/cache", () => ({
  revalidatePath: () => {
    throw new Error("a core revalidated a page");
  },
}));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

let dataDir: string;
let rawDb: import("better-sqlite3").Database;
let interactionCore: typeof import("@/server/interaction-core");
let reminderCore: typeof import("@/server/reminder-core");
let membershipCore: typeof import("@/server/membership-core");
let importEngine: typeof import("@/server/import-engine");
let queries: typeof import("@/server/queries");

function addContact(name: string, extra: Record<string, unknown> = {}): number {
  const cols = { display_name: name, created_at: NOW, updated_at: NOW, ...extra };
  const keys = Object.keys(cols);
  return Number(
    rawDb
      .prepare(`INSERT INTO contacts (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...Object.values(cols)).lastInsertRowid
  );
}
function contact(id: number) {
  return rawDb.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Record<string, unknown>;
}
function count(table: string, where = "1=1", ...params: unknown[]): number {
  return (rawDb.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rolo-cores-"));
  process.env.ROLO_DATA_DIR = dataDir;
  const client = await import("@/db/client");
  rawDb = client.rawDb;
  migrate(client.db, { migrationsFolder: path.join(__dirname, "../../src/db/migrations") });
  interactionCore = await import("@/server/interaction-core");
  reminderCore = await import("@/server/reminder-core");
  membershipCore = await import("@/server/membership-core");
  importEngine = await import("@/server/import-engine");
  queries = await import("@/server/queries");
});

afterAll(() => {
  rawDb?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("recordInteraction", () => {
  it("logs a manual interaction and moves the keep-in-touch clock", () => {
    const id = addContact("Ana Silva", { cadence_days: 30, cadence_assigned_at: NOW - 90 * DAY });
    const at = NOW - 2 * DAY;
    const res = interactionCore.recordInteraction({
      contactId: id,
      kind: "manual",
      occurredAt: at,
      title: "  Coffee  ",
      source: "user",
    });
    expect(res).toMatchObject({ ok: true, created: true, countsForTouch: true, noteId: null });
    expect(contact(id).last_interaction_at).toBe(at);
    expect(contact(id).next_touch_at).toBe(at + 30 * DAY);
    const row = rawDb.prepare("SELECT * FROM interactions WHERE contact_id = ?").get(id) as Record<string, unknown>;
    expect(row).toMatchObject({ kind: "manual", title: "Coffee", source: "user", direction: null, counts_for_touch: 1 });
  });

  it("an inbound email logged by an agent does not reset the clock; an outbound one does (SPEC §3)", () => {
    const id = addContact("Ben Okafor", { cadence_days: 30, cadence_assigned_at: NOW - 10 * DAY });
    const before = { ...contact(id) };
    interactionCore.recordInteraction({
      contactId: id,
      kind: "manual",
      occurredAt: NOW - 20 * DAY,
      source: "user",
    });
    const baseline = contact(id);
    expect(baseline.last_interaction_at).toBe(NOW - 20 * DAY);

    const inbound = interactionCore.recordInteraction({
      contactId: id,
      kind: "email",
      direction: "inbound",
      occurredAt: NOW - DAY,
      title: "Re: Introduction",
      source: "agent",
      sourceKey: "gmail:in-1",
      meta: { threadId: "t1" },
    });
    expect(inbound).toMatchObject({ ok: true, created: true, countsForTouch: false });
    expect(contact(id).last_interaction_at).toBe(baseline.last_interaction_at);
    expect(contact(id).next_touch_at).toBe(baseline.next_touch_at);

    const outbound = interactionCore.recordInteraction({
      contactId: id,
      kind: "email",
      direction: "outbound",
      occurredAt: NOW - 2 * DAY,
      title: "Introduction",
      source: "agent",
      sourceKey: "gmail:out-1",
    });
    expect(outbound).toMatchObject({ ok: true, countsForTouch: true });
    expect(contact(id).last_interaction_at).toBe(NOW - 2 * DAY);
    expect(contact(id).next_touch_at).toBe(NOW - 2 * DAY + 30 * DAY);
    expect(before.last_interaction_at).toBeNull();
    const stored = rawDb
      .prepare("SELECT meta FROM interactions WHERE source_key = 'gmail:in-1'")
      .get() as { meta: string };
    expect(JSON.parse(stored.meta)).toEqual({ threadId: "t1" });
  });

  it("the same sourceKey twice writes one row; a different key writes another", () => {
    const id = addContact("Cleo Idempotent");
    const input = {
      contactId: id,
      kind: "email" as const,
      direction: "outbound" as const,
      occurredAt: NOW - DAY,
      title: "Hello",
      source: "agent",
      sourceKey: "gmail:abc",
      noteMd: "Asked for a call.",
    };
    const first = interactionCore.recordInteraction(input);
    const second = interactionCore.recordInteraction(input);
    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false, noteId: null });
    if (first.ok && second.ok) expect(second.interactionId).toBe(first.interactionId);
    expect(count("interactions", "contact_id = ?", id)).toBe(1);
    // The repeat did not write the note a second time either.
    expect(count("notes", "contact_id = ?", id)).toBe(1);

    interactionCore.recordInteraction({ ...input, sourceKey: "gmail:def", noteMd: undefined });
    expect(count("interactions", "contact_id = ?", id)).toBe(2);
    // The key is scoped to its source: the owner's own row is not the agent's.
    interactionCore.recordInteraction({ ...input, source: "user", noteMd: undefined });
    expect(count("interactions", "contact_id = ?", id)).toBe(3);
  });

  it("an attached note is dated to the interaction, does not count, and keeps its mentions", () => {
    const id = addContact("Dana Note");
    const other = addContact("Eli Mentioned");
    const at = NOW - 5 * DAY;
    const res = interactionCore.recordInteraction({
      contactId: id,
      kind: "meeting",
      occurredAt: at,
      source: "agent",
      noteMd: `Call with [@Eli Mentioned](mention://contact/${other}) about the team.`,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const note = rawDb.prepare("SELECT * FROM notes WHERE id = ?").get(res.noteId) as Record<string, unknown>;
    expect(note).toMatchObject({ contact_id: id, counts_for_touch: 0, created_at: at });
    expect(count("note_mentions", "note_id = ? AND contact_id = ?", res.noteId, other)).toBe(1);
  });

  it("refuses an unknown contact, a bad time, a bad direction and an overlong title", () => {
    const id = addContact("Finn Valid");
    const base = { contactId: id, kind: "manual" as const, occurredAt: NOW, source: "agent" };
    expect(interactionCore.recordInteraction({ ...base, contactId: 999_999 })).toEqual({
      ok: false,
      error: "Contact not found.",
    });
    expect(interactionCore.recordInteraction({ ...base, occurredAt: 1.5 }).ok).toBe(false);
    expect(
      interactionCore.recordInteraction({ ...base, direction: "sideways" as unknown as "inbound" }).ok
    ).toBe(false);
    expect(interactionCore.recordInteraction({ ...base, title: "x".repeat(501) }).ok).toBe(false);
    expect(interactionCore.recordInteraction({ ...base, source: "" }).ok).toBe(false);
    expect(count("interactions", "contact_id = ?", id)).toBe(0);
  });
});

describe("recordInteraction inside a caller's transaction", () => {
  it("joins it: the quick log creates a person and their first entry together, or neither", async () => {
    const { db } = await import("@/db/client");
    const { contacts } = await import("@/db/schema");
    const insert = () =>
      db
        .insert(contacts)
        .values({ displayName: "Uma Nested", createdAt: NOW, updatedAt: NOW })
        .returning({ id: contacts.id })
        .get().id;

    const id = db.transaction(() => {
      const created = insert();
      const logged = interactionCore.recordInteraction({
        contactId: created,
        kind: "manual",
        occurredAt: NOW - DAY,
        title: "Met at demo day",
        source: "user",
      });
      if (!logged.ok) throw new Error(logged.error);
      return created;
    });
    expect(count("interactions", "contact_id = ?", id)).toBe(1);
    expect(contact(id).last_interaction_at).toBe(NOW - DAY);

    // A failure after the core ran takes the contact and the entry with it.
    const before = count("contacts");
    expect(() =>
      db.transaction(() => {
        const created = insert();
        interactionCore.recordInteraction({
          contactId: created,
          kind: "manual",
          occurredAt: NOW,
          source: "user",
        });
        throw new Error("rolled back");
      })
    ).toThrow("rolled back");
    expect(count("contacts")).toBe(before);
    expect(count("interactions", "title IS NULL AND occurred_at = ?", NOW)).toBe(0);
  });
});

describe("addNote", () => {
  it("a counting standalone note is a touch for everyone it mentions", () => {
    const ana = addContact("Gia Mention");
    const ben = addContact("Hal Mention");
    const at = NOW - 3 * DAY;
    const res = interactionCore.addNote({
      contactId: null,
      bodyMd: `Dinner with [@Gia](mention://contact/${ana}) and [@Hal](mention://contact/${ben}).`,
      countsForTouch: true,
      createdAt: at,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.contactIds.sort()).toEqual([ana, ben].sort());
    expect(contact(ana).last_interaction_at).toBe(at);
    expect(contact(ben).last_interaction_at).toBe(at);
  });

  it("a plain note is filed, searchable by row, and not a touch", () => {
    const id = addContact("Ivy Plain");
    const res = interactionCore.addNote({ contactId: id, bodyMd: "Prefers email over calls." });
    expect(res).toMatchObject({ ok: true, contactIds: [id] });
    expect(contact(id).last_interaction_at).toBeNull();
    expect(interactionCore.addNote({ contactId: 999_999, bodyMd: "x" })).toEqual({
      ok: false,
      error: "Contact not found.",
    });
  });
});

describe("createReminder / completeReminder", () => {
  it("creates a one-off attached to a contact and completes it once", () => {
    const id = addContact("Jo Reminder");
    const res = reminderCore.createReminder({
      title: " Follow up if no reply ",
      dueAt: NOW + 7 * DAY,
      contactId: id,
    });
    expect(res).toMatchObject({ ok: true, contactId: id, recurring: false });
    if (!res.ok) return;
    const row = rawDb.prepare("SELECT * FROM reminders WHERE id = ?").get(res.reminderId) as Record<string, unknown>;
    expect(row).toMatchObject({ title: "Follow up if no reply", contact_id: id, rrule: null, body: null });

    expect(reminderCore.completeReminder(res.reminderId)).toEqual({ ok: true, contactId: id, changed: true });
    expect(reminderCore.completeReminder(res.reminderId)).toEqual({ ok: true, contactId: id, changed: false });
    expect(reminderCore.completeReminder(999_999)).toEqual({ ok: false, error: "Reminder not found." });
  });

  it("a recurring rule materializes its first occurrence, and completing it shows the next", () => {
    const start = NOW + DAY;
    const res = reminderCore.createReminder({ title: "Weekly review", dueAt: start, rrule: "FREQ=WEEKLY" });
    expect(res).toMatchObject({ ok: true, recurring: true });
    if (!res.ok) return;
    const occurrences = () =>
      rawDb
        .prepare("SELECT id, due_at, completed_at FROM reminders WHERE series_id = ? ORDER BY due_at")
        .all(res.reminderId) as { id: number; due_at: number; completed_at: number | null }[];
    expect(occurrences().map((o) => o.due_at)).toEqual([start]);
    reminderCore.completeReminder(occurrences()[0].id);
    expect(occurrences().map((o) => o.due_at)).toEqual([start, start + 7 * DAY]);
  });

  it("refuses an empty title, an unsupported rule and an unknown contact", () => {
    const before = count("reminders");
    expect(reminderCore.createReminder({ title: "  ", dueAt: NOW }).ok).toBe(false);
    expect(reminderCore.createReminder({ title: "x", dueAt: NOW, rrule: "FREQ=SECONDLY" })).toEqual({
      ok: false,
      error: reminderCore.RRULE_ERROR,
    });
    expect(reminderCore.createReminder({ title: "x", dueAt: NOW, contactId: 999_999 })).toEqual({
      ok: false,
      error: "Contact not found.",
    });
    expect(count("reminders")).toBe(before);
  });
});

describe("tag and group membership", () => {
  it("findOrCreateTag is case-insensitive, so synonyms by capitalisation never appear", () => {
    const first = membershipCore.findOrCreateTag("Investor");
    const again = membershipCore.findOrCreateTag("  investor ");
    expect(first).toMatchObject({ ok: true, created: true, name: "Investor" });
    expect(again).toMatchObject({ ok: true, created: false, name: "Investor" });
    if (first.ok && again.ok) expect(again.tagId).toBe(first.tagId);
    expect(membershipCore.findOrCreateTag("").ok).toBe(false);
    expect(membershipCore.findOrCreateTag("x".repeat(51)).ok).toBe(false);
  });

  it("reports only the contacts whose membership it flipped", () => {
    const a = addContact("Kai Tagged");
    const b = addContact("Lou Tagged");
    const tag = membershipCore.findOrCreateTag("Tech IB");
    if (!tag.ok) throw new Error("tag");
    expect(membershipCore.setTagMembership([a], tag.tagId, true)).toEqual({
      ok: true,
      changedContactIds: [a],
      unknownContactIds: [],
    });
    // a already has it; b gets it; 999999 is nobody.
    expect(membershipCore.setTagMembership([a, b, 999_999, b], tag.tagId, true)).toEqual({
      ok: true,
      changedContactIds: [b],
      unknownContactIds: [999_999],
    });
    expect(count("contact_tags", "tag_id = ?", tag.tagId)).toBe(2);
    expect(membershipCore.setTagMembership([a], tag.tagId, false)).toMatchObject({ changedContactIds: [a] });
    expect(membershipCore.setTagMembership([a], tag.tagId, false)).toMatchObject({ changedContactIds: [] });
    expect(count("contact_tags", "tag_id = ?", tag.tagId)).toBe(1);
    expect(membershipCore.setTagMembership([a], 999_999, true)).toEqual({ ok: false, error: "Tag not found." });
  });

  it("group membership follows the same contract", () => {
    const a = addContact("Mo Grouped");
    const groupId = Number(
      rawDb.prepare("INSERT INTO groups (name, created_at) VALUES ('Tech IB 2027', ?)").run(NOW).lastInsertRowid
    );
    expect(membershipCore.setGroupMembership([a], groupId, true)).toMatchObject({ changedContactIds: [a] });
    expect(membershipCore.setGroupMembership([a], groupId, true)).toMatchObject({ changedContactIds: [] });
    expect(count("group_members", "group_id = ?", groupId)).toBe(1);
    expect(membershipCore.setGroupMembership([a], groupId, false)).toMatchObject({ changedContactIds: [a] });
    expect(count("group_members", "group_id = ?", groupId)).toBe(0);
    expect(membershipCore.setGroupMembership([a], 999_999, true)).toEqual({ ok: false, error: "Group not found." });
  });
});

describe("executeFilter", () => {
  it("runs a compiled filter with a total and a page", () => {
    const tag = membershipCore.findOrCreateTag("Filter probe");
    if (!tag.ok) throw new Error("tag");
    const ids = ["Nia One", "Oz Two", "Pat Three"].map((n) => addContact(n, { company: "Probe Co" }));
    membershipCore.setTagMembership(ids, tag.tagId, true);
    const all = queries.executeFilter({ v: 1, clauses: [{ dim: "tag", ids: [tag.tagId] }] }, { now: NOW });
    expect(all.total).toBe(3);
    expect(all.contacts.map((c) => c.id).sort()).toEqual([...ids].sort());
    const page = queries.executeFilter(
      { v: 1, clauses: [{ dim: "tag", ids: [tag.tagId] }] },
      { now: NOW, limit: 2, offset: 2, sort: { key: "name", dir: "asc" } }
    );
    expect(page.total).toBe(3);
    expect(page.contacts.map((c) => c.displayName)).toEqual(["Pat Three"]);
  });
});

describe("applyImportRow as source 'agent'", () => {
  const person = {
    firstName: "Quinn",
    lastName: "Banker",
    title: "Analyst",
    company: "Evercore",
    emails: [{ email: "quinn.banker@evercore.example" }],
    phones: [],
    socials: [],
  };
  const provenance = (id: number) =>
    Object.fromEntries(
      (
        rawDb.prepare("SELECT field, source FROM contact_field_sources WHERE contact_id = ?").all(id) as {
          field: string;
          source: string;
        }[]
      ).map((r) => [r.field, r.source])
    );

  it("a dry run plans and writes nothing", () => {
    const before = count("contacts");
    const res = importEngine.applyImportRow(person, { source: "agent", dryRun: true });
    expect(res).toMatchObject({ ok: true, contactId: null });
    if (res.ok) expect(res.plan.status).toBe("new");
    expect(count("contacts")).toBe(before);
  });

  it("creates a contact with agent provenance; the same email resolves to it afterwards", () => {
    const res = importEngine.applyImportRow(person, { source: "agent" });
    expect(res.ok).toBe(true);
    if (!res.ok || res.contactId === null) throw new Error("no contact");
    const id = res.contactId;
    expect(contact(id)).toMatchObject({ display_name: "Quinn Banker", title: "Analyst", company: "Evercore" });
    expect(provenance(id)).toEqual({
      first_name: "agent",
      last_name: "agent",
      title: "agent",
      company: "agent",
    });
    expect(
      rawDb.prepare("SELECT source FROM contact_emails WHERE contact_id = ?").get(id)
    ).toEqual({ source: "agent" });

    const again = importEngine.applyImportRow(
      { emails: [{ email: "Quinn.Banker@evercore.example" }], phones: [], socials: [], location: "London" },
      { source: "agent" }
    );
    expect(again).toMatchObject({ ok: true, contactId: id });
    if (again.ok) expect(again.plan).toMatchObject({ status: "updated", matchedBy: "email" });
    expect(contact(id).location).toBe("London");
    expect(count("contacts", "display_name = 'Quinn Banker'")).toBe(1);
    expect(importEngine.matchContact({ emails: [{ email: "quinn.banker@evercore.example" }], phones: [], socials: [] })).toEqual({
      contactId: id,
      matchedBy: "email",
    });
  });

  it("an owner-edited field is reported as a conflict and left alone, while empty fields still fill", () => {
    const id = addContact("Rae Owner", { first_name: "Rae", last_name: "Owner", title: "VP" });
    rawDb
      .prepare("INSERT INTO contact_emails (contact_id, email, email_normalized, priority, source, created_at) VALUES (?, ?, ?, 0, 'user', ?)")
      .run(id, "rae@owner.example", "rae@owner.example", NOW);
    rawDb
      .prepare("INSERT INTO contact_field_sources (contact_id, field, source, updated_at) VALUES (?, 'title', 'user', ?)")
      .run(id, NOW);
    const res = importEngine.applyImportRow(
      {
        emails: [{ email: "rae@owner.example" }],
        phones: [],
        socials: [],
        title: "Managing Director",
        company: "Moelis",
      },
      { source: "agent" }
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.status).toBe("conflict");
    expect(res.plan.conflicts).toEqual([
      { field: "title", incoming: "Managing Director", stored: "VP", storedSource: "user" },
    ]);
    expect(contact(id)).toMatchObject({ title: "VP", company: "Moelis" });
    expect(provenance(id)).toMatchObject({ title: "user", company: "agent" });
  });

  it("overwriting its own earlier value records the move as a job change", () => {
    const res = importEngine.applyImportRow({ ...person, title: "Associate" }, { source: "agent" });
    expect(res.ok).toBe(true);
    if (!res.ok || res.contactId === null) return;
    expect(contact(res.contactId).title).toBe("Associate");
    expect(
      rawDb
        .prepare("SELECT field, old_value, new_value, source FROM contact_changes WHERE contact_id = ?")
        .all(res.contactId)
    ).toEqual([{ field: "title", old_value: "Analyst", new_value: "Associate", source: "agent" }]);
  });

  it("refuses a row with no identity", () => {
    expect(importEngine.applyImportRow({ emails: [], phones: [], socials: [], title: "x" }, { source: "agent" }).ok).toBe(false);
  });
});

describe("agent ledger tables (migration 0020)", () => {
  const insertCall = (tool: string, key: string | null, status: string) =>
    rawDb
      .prepare("INSERT INTO agent_calls (tool, args_json, status, idempotency_key, created_at) VALUES (?, '{}', ?, ?, ?)")
      .run(tool, status, key, NOW);

  it("allows one successful call per (tool, idempotency key)", () => {
    insertCall("log_interaction", "gmail:1", "success");
    expect(() => insertCall("log_interaction", "gmail:1", "success")).toThrow(/UNIQUE/);
    // A failed attempt does not burn the key, another tool may reuse it,
    // and calls without a key never collide.
    insertCall("log_interaction", "gmail:2", "error");
    insertCall("log_interaction", "gmail:2", "success");
    insertCall("add_note", "gmail:1", "success");
    insertCall("search_contacts", null, "success");
    insertCall("search_contacts", null, "success");
    expect(count("agent_calls")).toBe(6);
  });

  it("a call outlives its grant and its contact", () => {
    const grant = Number(
      rawDb
        .prepare("INSERT INTO agent_grants (client_id, scope, resource, access_token_hash, created_at) VALUES ('claude', 'read', 'https://rolo.example/api/mcp', 'h1', ?)")
        .run(NOW).lastInsertRowid
    );
    const person = addContact("Sam Ledger");
    const call = Number(
      rawDb
        .prepare("INSERT INTO agent_calls (grant_id, tool, args_json, status, contact_id, created_at) VALUES (?, 'get_contacts', '{}', 'success', ?, ?)")
        .run(grant, person, NOW).lastInsertRowid
    );
    expect(() =>
      rawDb
        .prepare("INSERT INTO agent_grants (client_id, scope, resource, access_token_hash, created_at) VALUES ('claude', 'read', 'r', 'h1', ?)")
        .run(NOW)
    ).toThrow(/UNIQUE/);
    rawDb.prepare("DELETE FROM agent_grants WHERE id = ?").run(grant);
    rawDb.prepare("DELETE FROM contacts WHERE id = ?").run(person);
    expect(rawDb.prepare("SELECT grant_id, contact_id FROM agent_calls WHERE id = ?").get(call)).toEqual({
      grant_id: null,
      contact_id: null,
    });
  });
});

describe("the server actions are still gated", () => {
  it("each wrapper asks for a session before touching its core", async () => {
    const id = addContact("Tess Gate");
    const before = count("interactions");
    const views = await import("@/server/views");
    const notes = await import("@/server/notes");
    const reminders = await import("@/server/reminders");
    const contactActions = await import("@/server/contacts");
    const gate = "a core asked for a session";
    await expect(views.runFilter({ v: 1, clauses: [] }, { now: NOW })).rejects.toThrow(gate);
    await expect(
      notes.logInteractionAction(id, { kind: "manual", title: "x", occurredAt: NOW })
    ).rejects.toThrow(gate);
    await expect(notes.createNoteAction(id)).rejects.toThrow(gate);
    await expect(reminders.completeReminderAction(1)).rejects.toThrow(gate);
    await expect(contactActions.bulkAddTagAction([id], 1)).rejects.toThrow(gate);
    expect(count("interactions")).toBe(before);
  });
});
