import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// SPEC §14, Phase 15: the seven write tools against a real database —
// what each writes and refuses, that the same message never lands twice,
// that nothing the owner typed is overwritten, that every write can be
// taken back without taking the owner's work with it, and that "ask me
// first" means nothing changes until the owner says so.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const NOW = Date.now();
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

let dataDir: string;
let rawDb: import("better-sqlite3").Database;
let tools: typeof import("@/server/agent/tools");
let ledgerModule: typeof import("@/server/agent/ledger");
let undoModule: typeof import("@/server/agent/undo");

const id: Record<string, number> = {};

function ins(table: string, row: Record<string, unknown>): number {
  const keys = Object.keys(row);
  return Number(
    rawDb
      .prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...Object.values(row)).lastInsertRowid
  );
}

function rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return rawDb.prepare(sql).all(...params) as T[];
}

function one<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T {
  return rawDb.prepare(sql).get(...params) as T;
}

function contact(name: string, extra: Record<string, unknown> = {}): number {
  const [first, ...rest] = name.split(" ");
  return ins("contacts", {
    first_name: first,
    last_name: rest.join(" ") || null,
    display_name: name,
    created_at: NOW - 100 * DAY,
    updated_at: NOW - 100 * DAY,
    ...extra,
  });
}

type Out = Record<string, unknown> & { error?: string; actionId?: number };
const WRITE = ["read", "write"];

function call(name: string, args: unknown = {}, scopes = WRITE): { isError: boolean; data: Out } {
  const res = tools.callAgentTool(name, args, { grantId: null, scopes, now: NOW });
  return { isError: res.isError, data: JSON.parse(res.text) as Out };
}

function ok(name: string, args: unknown = {}): Out {
  const res = call(name, args);
  expect(res.isError, `${name} ${JSON.stringify(args)} → ${JSON.stringify(res.data).slice(0, 300)}`).toBe(false);
  return res.data;
}

function refused(name: string, args: unknown = {}): string {
  const res = call(name, args);
  expect(res.isError, `${name} ${JSON.stringify(args)} → ${JSON.stringify(res.data).slice(0, 300)}`).toBe(true);
  return String(res.data.error);
}

function ledger(): Record<string, unknown>[] {
  return rows("SELECT * FROM agent_calls ORDER BY id");
}

/** Every table a write could reach, as one string. */
function fingerprint(): string {
  return ["contacts", "contact_emails", "contact_socials", "contact_field_sources", "contact_changes", "interactions", "notes", "reminders", "tags", "contact_tags", "groups", "group_members"]
    .map((t) => `${t}:${JSON.stringify(rows(`SELECT * FROM "${t}" ORDER BY 1, 2`))}`)
    .join("\n");
}

const email = (contactId: number, over: Record<string, unknown> = {}) => ({
  contactId,
  kind: "email",
  direction: "outbound",
  occurredAt: at(2 * DAY),
  subject: "LBS student — 15 minutes?",
  category: "outreach",
  idempotencyKey: "gmail:msg-1",
  ...over,
});

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rolo-writes-"));
  process.env.ROLO_DATA_DIR = dataDir;
  const client = await import("@/db/client");
  rawDb = client.rawDb;
  migrate(client.db, { migrationsFolder: path.join(__dirname, "../../src/db/migrations") });
  tools = await import("@/server/agent/tools");
  ledgerModule = await import("@/server/agent/ledger");
  undoModule = await import("@/server/agent/undo");
});

beforeEach(() => {
  for (const t of ["agent_calls", "contacts", "reminders", "tags", "groups", "notes"]) {
    rawDb.prepare(`DELETE FROM ${t}`).run();
  }
  rawDb.prepare("DELETE FROM settings WHERE key = 'agent.write_mode'").run();

  // Ana: a banker the owner keeps in touch with monthly, last spoken to
  // 40 days ago. Her title was typed by the owner; her company came from
  // LinkedIn.
  id.ana = contact("Ana Silva", {
    title: "Vice President",
    company: "Goldman Sachs",
    cadence_days: 30,
    // Derived columns, as the cadence engine would have left them.
    last_interaction_at: NOW - 40 * DAY,
    next_touch_at: NOW - 10 * DAY,
  });
  ins("contact_emails", { contact_id: id.ana, email: "ana.silva@gs.test", email_normalized: "ana.silva@gs.test", source: "linkedin", created_at: NOW - 100 * DAY });
  ins("contact_socials", { contact_id: id.ana, platform: "linkedin", url: "https://www.linkedin.com/in/ana-silva", source: "linkedin", created_at: NOW - 100 * DAY });
  ins("contact_field_sources", { contact_id: id.ana, field: "title", source: "user", updated_at: NOW - 50 * DAY });
  ins("contact_field_sources", { contact_id: id.ana, field: "company", source: "linkedin", updated_at: NOW - 100 * DAY });
  ins("interactions", { contact_id: id.ana, kind: "manual", occurred_at: NOW - 40 * DAY, source: "user", counts_for_touch: 1, created_at: NOW - 40 * DAY });
  // Ben: a LinkedIn connection with no email and nothing typed by hand.
  id.ben = contact("Ben Okafor", { title: "Analyst", company: "Lazard" });
  ins("contact_socials", { contact_id: id.ben, platform: "linkedin", url: "https://www.linkedin.com/in/ben-okafor", source: "linkedin", created_at: NOW - 100 * DAY });
  ins("contact_field_sources", { contact_id: id.ben, field: "title", source: "linkedin", updated_at: NOW - 100 * DAY });
  ins("contact_field_sources", { contact_id: id.ben, field: "company", source: "linkedin", updated_at: NOW - 100 * DAY });
  id.banking = ins("tags", { name: "Banking", color: "#3b82f6", created_at: NOW - 100 * DAY });
  id.lbs = ins("groups", { name: "LBS", created_at: NOW - 100 * DAY });
});

afterAll(() => {
  rawDb?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("log_interaction", () => {
  it("logs an email the owner sent: attributed, keyed, counted as a touch, ledgered with its undo", () => {
    const out = ok("log_interaction", email(id.ana, { gmailThreadId: "18c0ffee18c0ffee", note: "Asked for 15 minutes on TMT recruiting." }));
    expect(out).toMatchObject({ logged: true, contactId: id.ana, contactName: "Ana Silva", resetsKeepInTouchClock: true });
    const row = one("SELECT * FROM interactions WHERE id = ?", out.interactionId);
    expect(row).toMatchObject({
      contact_id: id.ana,
      kind: "email",
      direction: "outbound",
      title: "LBS student — 15 minutes?",
      source: "agent",
      source_key: "gmail:msg-1",
      counts_for_touch: 1,
      occurred_at: NOW - 2 * DAY,
    });
    expect(JSON.parse(String(row.meta))).toEqual({ category: "outreach", threadId: "18c0ffee18c0ffee" });
    // The summary is a note beside it, dated to the exchange, not itself a touch.
    expect(one("SELECT * FROM notes WHERE id = ?", out.noteId)).toMatchObject({
      contact_id: id.ana,
      body_md: "Asked for 15 minutes on TMT recruiting.",
      counts_for_touch: 0,
      created_at: NOW - 2 * DAY,
    });
    // The keep-in-touch clock moved from the old catch-up to this send.
    expect(one("SELECT last_interaction_at, next_touch_at FROM contacts WHERE id = ?", id.ana)).toEqual({
      last_interaction_at: NOW - 2 * DAY,
      next_touch_at: NOW - 2 * DAY + 30 * DAY,
    });
    const [entry] = ledger();
    expect(entry).toMatchObject({
      id: out.actionId,
      tool: "log_interaction",
      status: "success",
      contact_id: id.ana,
      summary: "Logged an outbound email with Ana Silva — LBS student — 15 minutes?",
      idempotency_key: `gmail:msg-1#contact:${id.ana}`,
      undone_at: null,
    });
    expect(JSON.parse(String(entry.writes_json))).toEqual([
      { table: "interactions", op: "insert", id: out.interactionId, contactId: id.ana },
      { table: "notes", op: "insert", id: out.noteId, contactId: id.ana, stamp: expect.any(Number) },
    ]);
  });

  it("a reply received is on the timeline but does not reset the clock", () => {
    const before = one("SELECT last_interaction_at, next_touch_at FROM contacts WHERE id = ?", id.ana);
    const out = ok("log_interaction", email(id.ana, { direction: "inbound", category: "reply", subject: "Re: LBS student — 15 minutes?" }));
    expect(out.resetsKeepInTouchClock).toBe(false);
    expect(one("SELECT counts_for_touch FROM interactions WHERE id = ?", out.interactionId)).toEqual({ counts_for_touch: 0 });
    expect(one("SELECT last_interaction_at, next_touch_at FROM contacts WHERE id = ?", id.ana)).toEqual(before);
  });

  it("a call or a meeting needs no direction and counts as a touch", () => {
    const phone = ok("log_interaction", { contactId: id.ben, kind: "call", occurredAt: at(DAY), category: "scheduling", idempotencyKey: "call:ben:1" });
    const row = one("SELECT kind, direction, meta, counts_for_touch FROM interactions WHERE id = ?", phone.interactionId);
    expect(row).toMatchObject({ kind: "manual", direction: null, counts_for_touch: 1 });
    expect(JSON.parse(String(row.meta))).toEqual({ category: "scheduling", channel: "call" });
    const coffee = ok("log_interaction", { contactId: id.ben, kind: "meeting", occurredAt: at(3 * DAY), subject: "Coffee at LBS", category: "other_personal", idempotencyKey: "meet:ben:1" });
    expect(one("SELECT kind FROM interactions WHERE id = ?", coffee.interactionId)).toEqual({ kind: "meeting" });
  });

  it("refuses what is not an exchange a person wrote, and writes nothing", () => {
    const before = fingerprint();
    for (const category of ["newsletter", "notification", "auto_reply", "bounce"]) {
      expect(refused("log_interaction", email(id.ana, { category, direction: "inbound" })), category).toMatch(/Newsletters, notifications, automatic replies and bounces are left out/);
    }
    expect(fingerprint()).toBe(before);
    expect(ledger().map((r) => [r.status, r.writes_json, r.idempotency_key])).toEqual(Array(4).fill(["refused", null, null]));
    // The key was not used up: the same message, correctly named, still logs.
    expect(ok("log_interaction", email(id.ana)).logged).toBe(true);
  });

  it("refuses arguments it cannot trust rather than guessing", () => {
    const before = fingerprint();
    expect(refused("log_interaction", email(id.ana, { direction: undefined }))).toMatch(/direction is required/);
    expect(refused("log_interaction", email(id.ana, { category: undefined }))).toMatch(/category/);
    expect(refused("log_interaction", email(id.ana, { category: "important" }))).toMatch(/category/);
    expect(refused("log_interaction", email(id.ana, { idempotencyKey: undefined }))).toMatch(/idempotencyKey/);
    expect(refused("log_interaction", email(id.ana, { idempotencyKey: "has a space" }))).toMatch(/printable/);
    expect(refused("log_interaction", email(id.ana, { occurredAt: at(-DAY) }))).toMatch(/in the future/);
    expect(refused("log_interaction", email(id.ana, { occurredAt: "last Tuesday" }))).toMatch(/occurredAt/);
    expect(refused("log_interaction", email(id.ana, { occurredAt: "1985-01-01T00:00:00Z" }))).toMatch(/too far in the past/);
    expect(refused("log_interaction", email(999_999))).toMatch(/no contact with id 999999/);
    expect(refused("log_interaction", email(id.ana, { kind: "sms" }))).toMatch(/kind/);
    // No way to store a mail body: unknown fields are an error, not ignored.
    expect(refused("log_interaction", email(id.ana, { body: "Dear Ana, …" }))).toMatch(/body/);
    expect(refused("log_interaction", email(id.ana, { gmailThreadId: "x' OR 1=1" }))).toMatch(/gmailThreadId/);
    expect(refused("log_interaction", email(id.ana, { subject: "x".repeat(301) }))).toMatch(/subject/);
    expect(fingerprint()).toBe(before);
    expect(ledger().every((r) => r.status === "refused")).toBe(true);
  });

  it("the same message twice is one row: the second call is answered from the first", () => {
    const first = ok("log_interaction", email(id.ana));
    const again = ok("log_interaction", email(id.ana));
    expect(again).toEqual({ alreadyDone: true, actionId: first.actionId, summary: expect.stringContaining("Logged an outbound email") });
    // Even if the agent's reading of it changed in between.
    expect(ok("log_interaction", email(id.ana, { subject: "A different reading", category: "follow_up" })).alreadyDone).toBe(true);
    expect(rows("SELECT id FROM interactions WHERE source = 'agent'")).toHaveLength(1);
    expect(ledger()).toHaveLength(1);
  });

  it("one message to two people is logged once for each", () => {
    const toAna = ok("log_interaction", email(id.ana));
    const toBen = ok("log_interaction", email(id.ben));
    expect(toAna.logged).toBe(true);
    expect(toBen.logged).toBe(true);
    expect(rows("SELECT contact_id FROM interactions WHERE source_key = 'gmail:msg-1' ORDER BY contact_id")).toEqual([{ contact_id: id.ana }, { contact_id: id.ben }]);
    expect(ok("log_interaction", email(id.ben)).alreadyDone).toBe(true);
  });

  it("the forwarded copy of a message already logged joins it, whatever id it arrives under", () => {
    const first = ok("log_interaction", email(id.ana));
    // Days later the owner forwards the sent mail to the Gmail the agent reads.
    const copy = ok("log_interaction", email(id.ana, { idempotencyKey: "gmail:msg-forwarded", subject: "FW: LBS student — 15 minutes?", occurredAt: at(2 * DAY - 2 * MINUTE) }));
    expect(copy).toMatchObject({ logged: false, alreadyRecorded: true, interactionId: first.interactionId });
    expect(rows("SELECT id FROM interactions WHERE source = 'agent'")).toHaveLength(1);
    // The no-op is recorded, but holds no key and offers nothing to undo.
    expect(ledger()[1]).toMatchObject({ status: "success", writes_json: "[]", idempotency_key: null });
    expect(ledgerModule.listAgentActivity().rows.map((r) => r.id)).toEqual([first.actionId]);
  });

  it("joins a row Rolo's own Gmail sync already recorded, and one the owner logged by hand", () => {
    const synced = ins("interactions", { contact_id: id.ben, kind: "email", direction: "outbound", occurred_at: NOW - 5 * DAY, title: "Quick question", source: "gmail", source_key: "gm-1", counts_for_touch: 1, created_at: NOW });
    expect(ok("log_interaction", email(id.ben, { occurredAt: at(5 * DAY + 30_000), subject: "Quick question", idempotencyKey: "gmail:other" }))).toMatchObject({ alreadyRecorded: true, interactionId: synced });
    const byHand = ins("interactions", { contact_id: id.ben, kind: "meeting", occurred_at: NOW - 6 * DAY, source: "user", counts_for_touch: 1, created_at: NOW });
    expect(ok("log_interaction", { contactId: id.ben, kind: "meeting", occurredAt: at(6 * DAY + 5 * MINUTE), subject: "Coffee", category: "other_personal", idempotencyKey: "cal:1" })).toMatchObject({ alreadyRecorded: true, interactionId: byHand });
    expect(rows("SELECT id FROM interactions WHERE source = 'agent'")).toEqual([]);
  });

  it("keeps apart what really is another exchange", () => {
    ok("log_interaction", email(id.ana));
    // The reply, a minute later.
    expect(ok("log_interaction", email(id.ana, { idempotencyKey: "gmail:msg-2", direction: "inbound", category: "reply", occurredAt: at(2 * DAY - MINUTE) })).logged).toBe(true);
    // Another subject in the same ten minutes.
    expect(ok("log_interaction", email(id.ana, { idempotencyKey: "gmail:msg-3", subject: "One more thing", occurredAt: at(2 * DAY - 2 * MINUTE) })).logged).toBe(true);
    // The same subject, the next day.
    expect(ok("log_interaction", email(id.ana, { idempotencyKey: "gmail:msg-4", category: "follow_up", occurredAt: at(DAY) })).logged).toBe(true);
    // A LinkedIn message at the same moment as the email.
    expect(ok("log_interaction", email(id.ana, { idempotencyKey: "li:1", kind: "message" })).logged).toBe(true);
    expect(rows("SELECT id FROM interactions WHERE source = 'agent'")).toHaveLength(5);
  });

  it("cleans what it stores: a subject is one line, a note cannot carry an image", () => {
    const out = ok("log_interaction", email(id.ana, { subject: "Re:\tcoffee\nnext week", note: "Summary ![x](https://evil.test/p.png?leak=1)\r\nSecond line" }));
    expect(one("SELECT title FROM interactions WHERE id = ?", out.interactionId)).toEqual({ title: "Re: coffee next week" });
    expect(one("SELECT body_md FROM notes WHERE id = ?", out.noteId)).toEqual({ body_md: "Summary [x](https://evil.test/p.png?leak=1)\nSecond line" });
  });
});

describe("add_note", () => {
  it("writes a note that is knowledge, not a touch", () => {
    const before = one("SELECT last_interaction_at FROM contacts WHERE id = ?", id.ana);
    const out = ok("add_note", { contactId: id.ana, text: "Covers **TMT**; prefers email to LinkedIn.\n- Went to LBS (MiF 2019)" });
    expect(one("SELECT contact_id, body_md, counts_for_touch FROM notes WHERE id = ?", out.noteId)).toEqual({
      contact_id: id.ana,
      body_md: "Covers **TMT**; prefers email to LinkedIn.\n- Went to LBS (MiF 2019)",
      counts_for_touch: 0,
    });
    expect(one("SELECT last_interaction_at FROM contacts WHERE id = ?", id.ana)).toEqual(before);
    expect(ledgerModule.agentNoteIds(id.ana)).toEqual([out.noteId]);
    expect(ledgerModule.agentNoteIds(id.ben)).toEqual([]);
  });

  it("can be backdated, never postdated, and never empty", () => {
    const out = ok("add_note", { contactId: id.ana, text: "Met at the LBS finance trek.", date: at(20 * DAY) });
    expect(one("SELECT created_at FROM notes WHERE id = ?", out.noteId)).toEqual({ created_at: NOW - 20 * DAY });
    expect(refused("add_note", { contactId: id.ana, text: "Later.", date: at(-2 * DAY) })).toMatch(/in the future/);
    expect(refused("add_note", { contactId: id.ana, text: "   " })).toMatch(/text/);
    expect(refused("add_note", { contactId: id.ana, text: String.fromCharCode(1, 2, 3) })).toMatch(/empty/);
    expect(refused("add_note", { contactId: id.ana, text: "x".repeat(5001) })).toMatch(/text/);
    expect(refused("add_note", { contactId: 424242, text: "No one." })).toMatch(/no contact/);
    expect(rows("SELECT id FROM notes")).toHaveLength(1);
  });

  it("with a key, a repeat writes nothing; without one, it is the caller's to avoid", () => {
    const first = ok("add_note", { contactId: id.ana, text: "Prefers mornings.", idempotencyKey: "note:ana:mornings" });
    expect(ok("add_note", { contactId: id.ana, text: "Prefers mornings.", idempotencyKey: "note:ana:mornings" })).toMatchObject({ alreadyDone: true, actionId: first.actionId });
    expect(rows("SELECT id FROM notes")).toHaveLength(1);
  });
});

describe("reminders", () => {
  it("creates a reminder, with or without a person", () => {
    const due = new Date(NOW + 7 * DAY).toISOString();
    const out = ok("create_reminder", { title: "Follow up if no reply", dueAt: due, contactId: id.ana, details: "Sent the first email on Tuesday." });
    expect(one("SELECT contact_id, title, body, due_at, rrule, completed_at FROM reminders WHERE id = ?", out.reminderId)).toEqual({
      contact_id: id.ana,
      title: "Follow up if no reply",
      body: "Sent the first email on Tuesday.",
      due_at: NOW + 7 * DAY,
      rrule: null,
      completed_at: null,
    });
    const loose = ok("create_reminder", { title: "Update CV", dueAt: due });
    expect(one("SELECT contact_id FROM reminders WHERE id = ?", loose.reminderId)).toEqual({ contact_id: null });
  });

  it("refuses a reminder for the past, the far future, or nobody", () => {
    expect(refused("create_reminder", { title: "Too late", dueAt: at(3 * DAY) })).toMatch(/in the past/);
    expect(refused("create_reminder", { title: "Too far", dueAt: new Date(NOW + 6 * 365 * DAY).toISOString() })).toMatch(/five years/);
    expect(refused("create_reminder", { title: "When?", dueAt: "soon" })).toMatch(/dueAt/);
    expect(refused("create_reminder", { title: "Who?", dueAt: new Date(NOW + DAY).toISOString(), contactId: 31337 })).toMatch(/no contact/);
    expect(refused("create_reminder", { title: "Weekly", dueAt: new Date(NOW + DAY).toISOString(), rrule: "FREQ=WEEKLY" })).toMatch(/rrule/);
    expect(rows("SELECT id FROM reminders")).toEqual([]);
  });

  it("completes one, once; undo opens it again", () => {
    const reminderId = ins("reminders", { contact_id: id.ana, title: "Chase Ana", due_at: NOW - DAY, created_at: NOW - 5 * DAY, updated_at: NOW - 5 * DAY });
    const done = ok("complete_reminder", { reminderId });
    expect(done).toMatchObject({ completed: true });
    expect(one<{ completed_at: number | null }>("SELECT completed_at FROM reminders WHERE id = ?", reminderId).completed_at).not.toBeNull();
    const again = ok("complete_reminder", { reminderId });
    expect(again).toMatchObject({ completed: false, alreadyComplete: true });
    expect(refused("complete_reminder", { reminderId: 5150 })).toMatch(/no reminder/);

    expect(ok("undo_agent_action", { actionId: done.actionId })).toMatchObject({ undone: true, reversed: ["reopened the reminder"] });
    expect(one("SELECT completed_at FROM reminders WHERE id = ?", reminderId)).toEqual({ completed_at: null });
    // The second call changed nothing, so it has nothing to take back.
    expect(refused("undo_agent_action", { actionId: again.actionId })).toMatch(/did not change anything/);
  });
});

describe("upsert_contact", () => {
  it("adds someone new, with every field marked as the agent's", () => {
    const out = ok("upsert_contact", { firstName: "Priya", lastName: "Nair", title: "Associate", company: "Evercore", location: "London, UK", emails: ["Priya.Nair@Evercore.test"], linkedinUrl: "https://uk.linkedin.com/in/priya-nair/?trk=x" });
    expect(out).toMatchObject({ created: true, name: "Priya Nair" });
    const cid = out.contactId as number;
    expect(one("SELECT first_name, last_name, display_name, title, company, location FROM contacts WHERE id = ?", cid)).toEqual({
      first_name: "Priya", last_name: "Nair", display_name: "Priya Nair", title: "Associate", company: "Evercore", location: "London, UK",
    });
    expect(rows("SELECT email_normalized, source FROM contact_emails WHERE contact_id = ?", cid)).toEqual([{ email_normalized: "priya.nair@evercore.test", source: "agent" }]);
    // Stored as a full address on LinkedIn's own host: it becomes a link on her page.
    expect(rows("SELECT url, source FROM contact_socials WHERE contact_id = ?", cid)).toEqual([{ url: "https://www.linkedin.com/in/priya-nair", source: "agent" }]);
    expect(new Set(rows<{ source: string }>("SELECT source FROM contact_field_sources WHERE contact_id = ?", cid).map((r) => r.source))).toEqual(new Set(["agent"]));
    expect(JSON.parse(String(ledger()[0].writes_json))).toEqual([{ table: "contacts", op: "insert", id: cid }]);
  });

  it("the same person again is found by email or profile, not added twice", () => {
    const first = ok("upsert_contact", { firstName: "Priya", lastName: "Nair", emails: ["priya.nair@evercore.test"] });
    const byEmail = ok("upsert_contact", { firstName: "Priya", lastName: "Nair", emails: ["PRIYA.NAIR@evercore.test"], company: "Evercore" });
    expect(byEmail).toMatchObject({ created: false, updated: true, contactId: first.contactId, fieldsSet: ["company"] });
    const byProfile = ok("upsert_contact", { linkedinUrl: "https://www.linkedin.com/in/ben-okafor/", emails: ["ben.okafor@lazard.test"] });
    expect(byProfile).toMatchObject({ created: false, updated: true, contactId: id.ben, emailsAdded: 1 });
    expect(one("SELECT count(*) AS n FROM contacts")).toEqual({ n: 3 });
    // And a third time changes nothing at all.
    const before = fingerprint();
    expect(ok("upsert_contact", { linkedinUrl: "https://www.linkedin.com/in/ben-okafor", emails: ["ben.okafor@lazard.test"] })).toMatchObject({ created: false, updated: false });
    expect(fingerprint()).toBe(before);
  });

  it("stops at a namesake and asks, instead of guessing who is who", () => {
    const before = fingerprint();
    const asked = ok("upsert_contact", { firstName: "ana", lastName: "SILVA", company: "Morgan Stanley" });
    expect(asked).toMatchObject({ created: false, needsDecision: true });
    expect(asked.existing).toEqual([{ contactId: id.ana, name: "Ana Silva", title: "Vice President", company: "Goldman Sachs" }]);
    expect(fingerprint()).toBe(before);
    // Someone whose name only contains hers is not a namesake.
    expect(ok("upsert_contact", { firstName: "Ana", lastName: "Silva Costa" }).created).toBe(true);
    // Told they are different people, it adds the second Ana.
    const second = ok("upsert_contact", { firstName: "Ana", lastName: "Silva", company: "Morgan Stanley", confirmNew: true });
    expect(second.created).toBe(true);
    expect(second.contactId).not.toBe(id.ana);
  });

  it("never overwrites what the owner typed or another source set; says so instead", () => {
    const out = ok("upsert_contact", { contactId: id.ana, title: "Managing Director", company: "Goldman Sachs International", location: "London, UK" });
    expect(out).toMatchObject({ created: false, contactId: id.ana });
    const conflicts = out.conflicts as { field: string; kept: string; setBy: string; notApplied: string }[];
    expect(conflicts.find((c) => c.field === "title")).toEqual({ field: "title", kept: "Vice President", setBy: "the owner", notApplied: "Managing Director" });
    const stored = one("SELECT title, company, location FROM contacts WHERE id = ?", id.ana);
    expect(stored.title).toBe("Vice President");
    // An empty field is filled; that is the only thing it changed.
    expect(stored.location).toBe("London, UK");
    expect(out.fieldsSet).toContain("location");
    expect(one("SELECT source FROM contact_field_sources WHERE contact_id = ? AND field = 'title'", id.ana)).toEqual({ source: "user" });
  });

  it("refuses to hang one person's address on another, and to add a nameless contact", () => {
    const before = fingerprint();
    expect(refused("upsert_contact", { contactId: id.ben, emails: ["ana.silva@gs.test"] })).toMatch(/already belongs to another contact: Ana Silva/);
    expect(refused("upsert_contact", { contactId: id.ben, linkedinUrl: "https://www.linkedin.com/in/ana-silva" })).toMatch(/LinkedIn profile already belongs to another contact/);
    expect(refused("upsert_contact", { emails: ["ana.silva@gs.test"], linkedinUrl: "https://www.linkedin.com/in/ben-okafor" })).toMatch(/match more than one contact/);
    expect(refused("upsert_contact", { emails: ["nobody@new.test"] })).toMatch(/needs a name/);
    for (const bad of [
      "https://example.test/in/x",
      "https://evil.test/linkedin.com/in/x",
      "https://linkedin.com.evil.test/in/x",
      "https://www.linkedin.com/company/goldman-sachs",
      "https://www.linkedin.com/in/x/overlay/contact-info",
      "https://user@www.linkedin.com/in/x",
      "javascript://www.linkedin.com/in/x",
    ]) {
      expect(refused("upsert_contact", { firstName: "X", linkedinUrl: bad }), bad).toMatch(/not a LinkedIn profile|linkedinUrl/);
    }
    expect(refused("upsert_contact", { firstName: "X", emails: ["not-an-email"] })).toMatch(/emails/);
    expect(refused("upsert_contact", {})).toMatch(/at least one detail/);
    expect(refused("upsert_contact", { contactId: 77777, title: "CEO" })).toMatch(/no contact/);
    // Nothing an agent may not set: cadence, archive, notes field, ids.
    expect(refused("upsert_contact", { contactId: id.ben, cadenceDays: 7 })).toMatch(/cadenceDays/);
    expect(refused("upsert_contact", { contactId: id.ben, archived: true })).toMatch(/archived/);
    expect(fingerprint()).toBe(before);
  });
});

describe("a runaway cannot bury the address book", () => {
  it("stops adding people at the daily limit; updates and undone additions do not count", async () => {
    const { MAX_NEW_CONTACTS_PER_DAY } = await import("@/server/agent/write-tools");
    let last: Out = {};
    for (let i = 0; i < MAX_NEW_CONTACTS_PER_DAY; i++) {
      last = ok("upsert_contact", { firstName: "Bulk", lastName: `Person ${i}` });
    }
    expect(refused("upsert_contact", { firstName: "One", lastName: "Too Many" })).toMatch(/50 new contacts have been added .* Nothing was added/);
    expect(one("SELECT count(*) AS n FROM contacts")).toEqual({ n: 2 + MAX_NEW_CONTACTS_PER_DAY });
    // Filling in someone already there is not adding.
    expect(ok("upsert_contact", { contactId: id.ben, location: "London, UK" }).updated).toBe(true);
    // Taking one back frees its place.
    ok("undo_agent_action", { actionId: last.actionId });
    expect(ok("upsert_contact", { firstName: "One", lastName: "More" }).created).toBe(true);
    // Yesterday's additions have aged out.
    rawDb.prepare("UPDATE agent_calls SET created_at = created_at - ?").run(25 * 60 * MINUTE);
    expect(ok("upsert_contact", { firstName: "Next", lastName: "Day" }).created).toBe(true);
  });
});

describe("tag_contacts", () => {
  it("reuses the owner's tag whatever the case, creates a new one when nothing fits, and fills groups", () => {
    const out = ok("tag_contacts", { contactIds: [id.ana, id.ben, id.ana], addTags: ["banking", "TMT"], addToGroupIds: [id.lbs] });
    expect(out).toMatchObject({ contacts: 2 });
    expect(rows("SELECT name FROM tags ORDER BY id")).toEqual([{ name: "Banking" }, { name: "TMT" }]);
    expect(one("SELECT count(*) AS n FROM contact_tags")).toEqual({ n: 4 });
    expect(one("SELECT count(*) AS n FROM group_members WHERE group_id = ?", id.lbs)).toEqual({ n: 2 });
    // Again: nothing left to do, nothing recorded as changed.
    const again = ok("tag_contacts", { contactIds: [id.ana, id.ben], addTags: ["Banking"] });
    expect(again.done).toEqual(['tagged 0 "Banking"']);
    expect(ledger()[1].writes_json).toBe("[]");
  });

  it("will not invent a taxonomy, or act on names and ids that do not exist", () => {
    const before = fingerprint();
    expect(refused("tag_contacts", { contactIds: [id.ana], addTags: ["Tier 1", "Tier 2", "Tier 3"] })).toMatch(/At most 2 per call/);
    expect(refused("tag_contacts", { contactIds: [id.ana], removeTags: ["Nonexistent"] })).toMatch(/no tag called "Nonexistent"/);
    expect(refused("tag_contacts", { contactIds: [id.ana], addToGroupIds: [9999] })).toMatch(/no group with id 9999/);
    expect(refused("tag_contacts", { contactIds: [8888, 8889], addTags: ["Banking"] })).toMatch(/None of those contact ids exist/);
    expect(refused("tag_contacts", { contactIds: [id.ana] })).toMatch(/what to add or remove/);
    expect(refused("tag_contacts", { contactIds: Array.from({ length: 51 }, (_, i) => i + 1), addTags: ["Banking"] })).toMatch(/contactIds/);
    // A bad group id in a call that also adds a new tag: the tag is not left behind.
    expect(refused("tag_contacts", { contactIds: [id.ana], addTags: ["Orphan"], removeFromGroupIds: [9999] })).toMatch(/no group/);
    expect(fingerprint()).toBe(before);
    // Unknown ids among real ones are reported, the rest done.
    expect(ok("tag_contacts", { contactIds: [id.ana, 8888], addTags: ["Banking"] })).toMatchObject({ contacts: 1, unknownContactIds: [8888] });
  });

  it("undo puts every membership back as it was, and removes a tag it created", () => {
    ins("contact_tags", { contact_id: id.ana, tag_id: id.banking, created_at: NOW });
    const before = fingerprint();
    const out = ok("tag_contacts", { contactIds: [id.ana, id.ben], addTags: ["TMT"], removeTags: ["Banking"], addToGroupIds: [id.lbs] });
    expect(fingerprint()).not.toBe(before);
    const undone = ok("undo_agent_action", { actionId: out.actionId });
    expect(undone.reversed).toEqual(["removed 2 group members", "re-tagged 1 contact", "untagged 2 contacts", "removed the new tag"]);
    expect(rows("SELECT contact_id, tag_id FROM contact_tags")).toEqual([{ contact_id: id.ana, tag_id: id.banking }]);
    expect(rows("SELECT name FROM tags")).toEqual([{ name: "Banking" }]);
    expect(rows("SELECT * FROM group_members")).toEqual([]);
  });

  it("undo keeps a new tag the owner has since put on someone else", () => {
    const out = ok("tag_contacts", { contactIds: [id.ana], addTags: ["TMT"] });
    const tmt = one<{ id: number }>("SELECT id FROM tags WHERE name = 'TMT'").id;
    ins("contact_tags", { contact_id: id.ben, tag_id: tmt, created_at: NOW });
    const undone = ok("undo_agent_action", { actionId: out.actionId });
    expect(undone.leftInPlace).toEqual(["the new tag is in use on other contacts, so it was kept"]);
    expect(rows("SELECT contact_id FROM contact_tags WHERE tag_id = ?", tmt)).toEqual([{ contact_id: id.ben }]);
  });
});

describe("undo", () => {
  it("removes exactly what the call wrote and puts the keep-in-touch clock back", () => {
    const before = fingerprint();
    const clock = one("SELECT last_interaction_at, next_touch_at FROM contacts WHERE id = ?", id.ana);
    const out = ok("log_interaction", email(id.ana, { note: "Asked for a call." }));
    expect(one("SELECT last_interaction_at FROM contacts WHERE id = ?", id.ana)).toEqual({ last_interaction_at: NOW - 2 * DAY });
    const undone = ok("undo_agent_action", { actionId: out.actionId });
    expect(undone).toMatchObject({ undone: true, reversed: ["removed the note", "removed the interaction"] });
    expect(undone.leftInPlace).toBeUndefined();
    expect(fingerprint()).toBe(before);
    expect(one("SELECT last_interaction_at, next_touch_at FROM contacts WHERE id = ?", id.ana)).toEqual(clock);
    expect(ledger().map((r) => [r.tool, r.undone_at !== null])).toEqual([["log_interaction", true], ["undo_agent_action", false]]);
  });

  it("an undone message stays undone: the agent's next pass does not put it back", () => {
    const out = ok("log_interaction", email(id.ana));
    ok("undo_agent_action", { actionId: out.actionId });
    const retry = ok("log_interaction", email(id.ana));
    expect(retry).toMatchObject({ alreadyDone: true, undone: true, actionId: out.actionId });
    expect(rows("SELECT id FROM interactions WHERE source = 'agent'")).toEqual([]);
    // Logged against the wrong person, undone, and logged again against the right one: allowed.
    expect(ok("log_interaction", email(id.ben)).logged).toBe(true);
  });

  it("leaves alone a note the owner has edited since", () => {
    const out = ok("log_interaction", email(id.ana, { note: "First draft of what was said." }));
    rawDb.prepare("UPDATE notes SET body_md = 'The owner rewrote this.', updated_at = updated_at + 5000 WHERE id = ?").run(out.noteId);
    const undone = ok("undo_agent_action", { actionId: out.actionId });
    expect(undone.reversed).toEqual(["removed the interaction"]);
    expect(undone.leftInPlace).toEqual(["the note was edited after it was written, so it was kept"]);
    expect(rows("SELECT body_md FROM notes")).toEqual([{ body_md: "The owner rewrote this." }]);
  });

  it("copes with what the owner already deleted by hand", () => {
    const out = ok("log_interaction", email(id.ana, { note: "A summary." }));
    rawDb.prepare("DELETE FROM interactions WHERE id = ?").run(out.interactionId);
    const undone = ok("undo_agent_action", { actionId: out.actionId });
    expect(undone).toMatchObject({ reversed: ["removed the note"], leftInPlace: ["the interaction was already gone"] });
  });

  it("restores the fields an update set, and only those still as the agent left them", () => {
    const out = ok("upsert_contact", { contactId: id.ben, location: "London, UK", title: "Associate", emails: ["ben.okafor@lazard.test"] });
    expect(out.fieldsSet).toEqual(expect.arrayContaining(["location"]));
    // The owner then corrects the location by hand.
    rawDb.prepare("UPDATE contacts SET location = 'Paris, France' WHERE id = ?").run(id.ben);
    const undone = ok("undo_agent_action", { actionId: out.actionId });
    expect(undone.leftInPlace).toContain("location has changed since, so it was left as it is");
    expect(undone.reversed).toContain("removed the email address");
    expect(one("SELECT location FROM contacts WHERE id = ?", id.ben)).toEqual({ location: "Paris, France" });
    expect(rows("SELECT id FROM contact_emails WHERE contact_id = ?", id.ben)).toEqual([]);
  });

  it("an update, undone untouched, leaves the contact exactly as it was", () => {
    const before = fingerprint();
    const out = ok("upsert_contact", { contactId: id.ben, location: "London, UK", emails: ["ben.okafor@lazard.test"] });
    expect(fingerprint()).not.toBe(before);
    ok("undo_agent_action", { actionId: out.actionId });
    const strip = (s: string) => s.replace(/"updated_at":\d+/g, '"updated_at":0');
    expect(strip(fingerprint())).toBe(strip(before));
  });

  it("removes a contact it added — unless the contact has since become more than that", () => {
    const made = ok("upsert_contact", { firstName: "Priya", lastName: "Nair", emails: ["priya.nair@evercore.test"] });
    const cid = made.contactId as number;
    const logged = ok("log_interaction", email(cid));
    expect(refused("undo_agent_action", { actionId: made.actionId })).toMatch(/Priya Nair now has other notes, interactions or reminders/);
    expect(one("SELECT count(*) AS n FROM contacts WHERE id = ?", cid)).toEqual({ n: 1 });
    expect(one("SELECT undone_at FROM agent_calls WHERE id = ?", made.actionId)).toEqual({ undone_at: null });
    // Take the later write back first, then the contact goes.
    ok("undo_agent_action", { actionId: logged.actionId });
    expect(ok("undo_agent_action", { actionId: made.actionId }).reversed).toEqual(["removed the contact Priya Nair"]);
    expect(one("SELECT count(*) AS n FROM contacts WHERE id = ?", cid)).toEqual({ n: 0 });
    expect(rows("SELECT id FROM contact_emails WHERE contact_id = ?", cid)).toEqual([]);
  });

  it("keeps a contact the owner has edited since it was added", () => {
    const made = ok("upsert_contact", { firstName: "Priya", lastName: "Nair" });
    ins("contact_field_sources", { contact_id: made.contactId, field: "title", source: "user", updated_at: NOW });
    expect(refused("undo_agent_action", { actionId: made.actionId })).toMatch(/edited by the owner since being added/);
    expect(one("SELECT count(*) AS n FROM contacts WHERE id = ?", made.contactId)).toEqual({ n: 1 });
  });

  it("only ever undoes an agent's own write, once", () => {
    const out = ok("add_note", { contactId: id.ana, text: "A note." });
    const read = tools.callAgentTool("get_contacts", { ids: [id.ana] }, { grantId: null, scopes: WRITE, now: NOW });
    expect(read.isError).toBe(false);
    const readId = one<{ id: number }>("SELECT id FROM agent_calls WHERE tool = 'get_contacts'").id;
    expect(refused("undo_agent_action", { actionId: readId })).toMatch(/did not change anything/);
    expect(refused("undo_agent_action", { actionId: 123456 })).toMatch(/no action with id 123456/);
    const undo = ok("undo_agent_action", { actionId: out.actionId });
    expect(refused("undo_agent_action", { actionId: out.actionId })).toMatch(/already been undone/);
    expect(refused("undo_agent_action", { actionId: undo.actionId })).toMatch(/cannot itself be undone/);
    expect(refused("undo_agent_action", { actionId: "1; DROP TABLE contacts" })).toMatch(/actionId/);
    expect(one("SELECT count(*) AS n FROM contacts")).toEqual({ n: 2 });
  });

  it("the owner's Undo button uses the same path and reports what it kept", () => {
    const out = ok("create_reminder", { title: "Send the deck", dueAt: new Date(NOW + DAY).toISOString(), contactId: id.ana });
    rawDb.prepare("UPDATE reminders SET title = 'Send the deck and the model', updated_at = updated_at + 1000 WHERE id = ?").run(out.reminderId);
    const res = undoModule.undoAgentCall(out.actionId!);
    expect(res).toMatchObject({ ok: true, reversed: [], skipped: ["the reminder was changed after it was created, so it was kept"], contactId: id.ana });
    expect(rows("SELECT title FROM reminders")).toEqual([{ title: "Send the deck and the model" }]);
  });
});

describe("a write is all or nothing", () => {
  it("a failure half way through leaves no trace and no claim of success", () => {
    const before = fingerprint();
    // The tag step will succeed; the group step will hit a missing table.
    rawDb.exec("ALTER TABLE group_members RENAME TO group_members_hidden");
    let res: ReturnType<typeof call>;
    try {
      res = call("tag_contacts", { contactIds: [id.ana], addTags: ["Halfway"], addToGroupIds: [id.lbs] });
    } finally {
      rawDb.exec("ALTER TABLE group_members_hidden RENAME TO group_members");
    }
    expect(res.isError).toBe(true);
    expect(res.data).toEqual({ error: "The tool failed inside Rolo. Nothing was changed." });
    expect(fingerprint()).toBe(before);
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0]).toMatchObject({ status: "error", writes_json: null, idempotency_key: null });
    expect(String(ledger()[0].error)).toMatch(/group_members/);
  });
});

describe("review mode: ask me first", () => {
  beforeEach(() => {
    ins("settings", { key: "agent.write_mode", value: JSON.stringify("review") });
  });

  it("queues every write and changes nothing until the owner approves", () => {
    expect(tools.agentWriteMode()).toBe("review");
    const before = fingerprint();
    const proposed = [
      ok("log_interaction", email(id.ana, { note: "Asked for a call." })),
      ok("add_note", { contactId: id.ben, text: "Moved to Lazard's TMT team." }),
      ok("create_reminder", { title: "Chase", dueAt: new Date(NOW + DAY).toISOString() }),
      ok("upsert_contact", { firstName: "Priya", lastName: "Nair" }),
      ok("tag_contacts", { contactIds: [id.ana], addTags: ["Banking"] }),
    ];
    for (const p of proposed) expect(p).toMatchObject({ queued: true, actionId: expect.any(Number) });
    expect(fingerprint()).toBe(before);
    expect(ledger().map((r) => [r.status, r.writes_json])).toEqual(Array(5).fill(["queued", null]));
    expect(ledgerModule.countQueuedAgentCalls()).toBe(5);
    const activity = ledgerModule.listAgentActivity();
    expect(activity).toMatchObject({ total: 5, queued: 5 });
    expect(activity.rows.every((r) => !r.undoable)).toBe(true);
    // Reading is never queued.
    expect(call("get_contacts", { ids: [id.ana] }).isError).toBe(false);
  });

  it("the same proposal again is the same proposal", () => {
    const first = ok("log_interaction", email(id.ana));
    expect(ok("log_interaction", email(id.ana))).toMatchObject({ queued: true, actionId: first.actionId });
    expect(ledger()).toHaveLength(1);
  });

  it("approving runs it exactly as proposed, and it can then be undone like any other", () => {
    const proposal = ok("log_interaction", email(id.ana, { note: "Asked for a call." }));
    const res = tools.approveQueuedCall(proposal.actionId!);
    expect(res).toEqual({ ok: true, summary: "Logged an outbound email with Ana Silva — LBS student — 15 minutes?" });
    expect(rows("SELECT source, source_key, title FROM interactions WHERE source = 'agent'")).toEqual([{ source: "agent", source_key: "gmail:msg-1", title: "LBS student — 15 minutes?" }]);
    const [entry] = ledger();
    expect(entry).toMatchObject({ id: proposal.actionId, status: "success", contact_id: id.ana, idempotency_key: `gmail:msg-1#contact:${id.ana}` });
    expect(JSON.parse(String(entry.writes_json))).toHaveLength(2);
    // Approving twice does nothing; the agent asking again is told it is done.
    expect(tools.approveQueuedCall(proposal.actionId!)).toEqual({ ok: false, error: "That proposal is no longer waiting." });
    expect(ok("log_interaction", email(id.ana))).toMatchObject({ alreadyDone: true, actionId: proposal.actionId });
    expect(rows("SELECT id FROM interactions WHERE source = 'agent'")).toHaveLength(1);
    expect(undoModule.undoAgentCall(proposal.actionId!)).toMatchObject({ ok: true, reversed: ["removed the note", "removed the interaction"] });
  });

  it("rejecting keeps the record, changes nothing, and the proposal does not come back", () => {
    const before = fingerprint();
    const proposal = ok("log_interaction", email(id.ana));
    expect(tools.rejectQueuedCall(proposal.actionId!)).toBe(true);
    expect(tools.rejectQueuedCall(proposal.actionId!)).toBe(false);
    expect(tools.approveQueuedCall(proposal.actionId!)).toMatchObject({ ok: false });
    expect(ok("log_interaction", email(id.ana))).toMatchObject({ rejected: true, actionId: proposal.actionId });
    expect(fingerprint()).toBe(before);
    expect(ledger().map((r) => r.status)).toEqual(["rejected"]);
    expect(ledgerModule.listAgentActivity()).toMatchObject({ total: 1, queued: 0 });
  });

  it("a proposal that no longer makes sense when approved is marked so, not forced", () => {
    const gone = contact("Carl Gone");
    const proposal = ok("add_note", { contactId: gone, text: "A note for someone about to be deleted." });
    rawDb.prepare("DELETE FROM contacts WHERE id = ?").run(gone);
    const res = tools.approveQueuedCall(proposal.actionId!);
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/no contact with id/) });
    expect(ledger()[0]).toMatchObject({ status: "refused", writes_json: null });
    expect(rows("SELECT id FROM notes")).toEqual([]);
  });

  it("a queued proposal cannot be undone, and undo itself is never queued", () => {
    const proposal = ok("add_note", { contactId: id.ana, text: "Waiting." });
    expect(refused("undo_agent_action", { actionId: proposal.actionId })).toMatch(/still waiting for the owner's approval/);
    // Something applied before review was switched on can still be taken back at once.
    rawDb.prepare("DELETE FROM settings WHERE key = 'agent.write_mode'").run();
    const applied = ok("add_note", { contactId: id.ana, text: "Applied directly." });
    ins("settings", { key: "agent.write_mode", value: JSON.stringify("review") });
    expect(ok("undo_agent_action", { actionId: applied.actionId })).toMatchObject({ undone: true });
    expect(rows("SELECT id FROM notes")).toEqual([]);
  });

  it("invalid proposals are refused at the door, not queued for the owner to puzzle over", () => {
    expect(refused("log_interaction", email(id.ana, { category: undefined }))).toMatch(/category/);
    expect(refused("add_note", { contactId: id.ana }, )).toMatch(/text/);
    expect(ledger().map((r) => r.status)).toEqual(["refused", "refused"]);
  });
});

describe("the activity page's list", () => {
  it("shows what changed, newest first, with what can still be undone", () => {
    const note = ok("add_note", { contactId: id.ana, text: "One." });
    const logged = ok("log_interaction", email(id.ben));
    ok("log_interaction", email(id.ben, { idempotencyKey: "gmail:copy", subject: "Fwd: LBS student — 15 minutes?" }));
    call("get_contacts", { ids: [id.ana] });
    call("add_note", { contactId: 999, text: "Refused." });
    const undo = ok("undo_agent_action", { actionId: note.actionId });
    const { rows: list, total, queued } = ledgerModule.listAgentActivity();
    expect({ total, queued }).toEqual({ total: 3, queued: 0 });
    expect(list.map((r) => [r.id, r.tool, r.undoable, r.undoneAt !== null, r.contactName])).toEqual([
      [undo.actionId, "undo_agent_action", false, false, "Ana Silva"],
      [logged.actionId, "log_interaction", true, false, "Ben Okafor"],
      [note.actionId, "add_note", false, true, "Ana Silva"],
    ]);
    expect(ledgerModule.listAgentActivity(1, 1).rows.map((r) => r.id)).toEqual([logged.actionId]);
  });
});
