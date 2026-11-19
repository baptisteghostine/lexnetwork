import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { zipSync, strToU8 } from "fflate";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// SPEC §15: WhatsApp per person, against a real migrated database — the
// link, the phone export, the collector's contract, the day rows on the
// timeline, the rolling summary and the retention rule. The laptop
// collector itself does not exist yet; its server side does, and is
// exercised here exactly as the collector will use it.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

let dataDir: string;
let rawDb: import("better-sqlite3").Database;
let wa: typeof import("@/server/whatsapp-core");
const id: Record<string, number> = {};

function ins(table: string, row: Record<string, unknown>): number {
  const keys = Object.keys(row);
  return Number(rawDb.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row)).lastInsertRowid);
}
const rows = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => rawDb.prepare(sql).all(...p) as T[];
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => rawDb.prepare(sql).get(...p) as T;

function contact(name: string, extra: Record<string, unknown> = {}): number {
  const [first, ...rest] = name.split(" ");
  return ins("contacts", { first_name: first, last_name: rest.join(" ") || null, display_name: name, created_at: NOW - 100 * DAY, updated_at: NOW - 100 * DAY, ...extra });
}

type Msg = import("@/lib/whatsapp/chat").WaMessage;
const m = (key: string, minutesAgo: number, direction: "inbound" | "outbound", body: string | null = "hello", kind: Msg["kind"] = "text"): Msg => ({
  key,
  direction,
  sentAt: NOW - minutesAgo * MINUTE,
  kind,
  body,
});

function link(contactId = id.chris, number = "+44 7911 123456", savedName = "John") {
  const res = wa.linkWhatsApp(contactId, { number, savedName }, NOW - 10 * DAY);
  if (!res.ok) throw new Error(res.error);
  return res.link;
}

function timeline(contactId = id.chris) {
  return rows<{ title: string; direction: string; counts_for_touch: number; occurred_at: number; source_key: string; meta: string }>(
    "SELECT title, direction, counts_for_touch, occurred_at, source_key, meta FROM interactions WHERE contact_id = ? AND source = 'whatsapp' ORDER BY occurred_at",
    contactId
  );
}

const EXPORT = [
  "[17/11/2026, 09:15:02] John: Morning! Still on for Thursday?",
  "[17/11/2026, 09:16:40] Baptiste G: Yes — 5pm at the usual place",
  "[17/11/2026, 09:17:05] John: <attached: 00000012-PHOTO.jpg>",
  "[18/11/2026, 21:02:11] John: Running late",
  "[18/11/2026, 21:02:11] John: ok",
  "[18/11/2026, 21:02:11] John: ok",
].join("\n");

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rolo-wa-"));
  process.env.ROLO_DATA_DIR = dataDir;
  const client = await import("@/db/client");
  rawDb = client.rawDb;
  migrate(client.db, { migrationsFolder: path.join(__dirname, "../../src/db/migrations") });
  wa = await import("@/server/whatsapp-core");
});

beforeEach(() => {
  for (const t of ["contacts", "sync_runs", "settings"]) rawDb.prepare(`DELETE FROM ${t}`).run();
  ins("settings", { key: "timezone", value: JSON.stringify("Europe/London") });
  // Chris: saved as "John" in WhatsApp. On a monthly rhythm, last seen 40 days ago.
  id.chris = contact("Chris Haswani", { cadence_days: 30, last_interaction_at: NOW - 40 * DAY, next_touch_at: NOW - 10 * DAY });
  ins("interactions", { contact_id: id.chris, kind: "manual", occurred_at: NOW - 40 * DAY, source: "user", counts_for_touch: 1, created_at: NOW - 40 * DAY });
  ins("notes", { contact_id: id.chris, body_md: "Met at LBS.", counts_for_touch: 0, created_at: NOW - 50 * DAY, updated_at: NOW - 50 * DAY });
  id.maya = contact("Maya Okoro");
});

afterAll(() => {
  rawDb?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("linking a chat", () => {
  it("is a number and the name they are saved under — sync starts off", () => {
    const l = link();
    expect(l).toMatchObject({ contactId: id.chris, waId: "447911123456", savedName: "John", syncEnabled: false, syncFrom: null });
    expect(wa.contactIdsBySavedName(" john ")).toEqual([id.chris]);
    expect(wa.contactIdsBySavedName("Chris")).toEqual([]);
  });

  it("refuses a number it cannot read, an empty name, a second chat, and a number someone else has", () => {
    expect(wa.linkWhatsApp(id.chris, { number: "John", savedName: "John" })).toEqual({ ok: false, error: expect.stringMatching(/not a phone number/) });
    expect(wa.linkWhatsApp(id.chris, { number: "+44 7911 123456", savedName: "   " })).toEqual({ ok: false, error: expect.stringMatching(/saved under/) });
    expect(wa.linkWhatsApp(987654, { number: "+44 7911 123456", savedName: "John" })).toEqual({ ok: false, error: "Contact not found." });
    link();
    expect(wa.linkWhatsApp(id.chris, { number: "+33 6 12 34 56 78", savedName: "John" })).toEqual({ ok: false, error: expect.stringMatching(/already has a WhatsApp chat/) });
    expect(wa.linkWhatsApp(id.maya, { number: "0044 7911 123456", savedName: "Maya" })).toEqual({ ok: false, error: "That number is already linked to Chris Haswani." });
    expect(rows("SELECT id FROM whatsapp_links")).toHaveLength(1);
  });

  it("a national number uses the owner's default region, and is refused without one", () => {
    expect(wa.linkWhatsApp(id.chris, { number: "07911 123456", savedName: "John" }).ok).toBe(false);
    ins("settings", { key: "phone_default_region", value: JSON.stringify("GB") });
    expect(wa.linkWhatsApp(id.chris, { number: "07911 123456", savedName: "John" })).toMatchObject({ ok: true, link: { waId: "447911123456" } });
  });
});

describe("the phone export", () => {
  it("lands on the timeline as one row per day, dated in the owner's timezone", () => {
    link();
    const res = wa.importWhatsAppExport(id.chris, strToU8(EXPORT), "_chat.txt", {}, NOW);
    expect(res).toMatchObject({ ok: true, added: 6, alreadyThere: 0, total: 6, timezone: "Europe/London", dateOrder: "day/month", dateOrderAssumed: false });
    expect(timeline().map((r) => [r.source_key, r.title, r.direction, r.counts_for_touch])).toEqual([
      ["wa-day:2026-11-17", "WhatsApp · 3 messages (1 sent, 2 received)", "outbound", 1],
      ["wa-day:2026-11-18", "WhatsApp · 3 messages received", "inbound", 0],
    ]);
    const first = timeline()[0];
    expect(first.occurred_at).toBe(Date.parse("2026-11-17T09:16:40Z"));
    expect(JSON.parse(first.meta)).toEqual({
      channel: "whatsapp",
      day: "2026-11-17",
      count: 3,
      sent: 1,
      received: 2,
      body: "John: Morning! Still on for Thursday?\nYou: Yes — 5pm at the usual place\nJohn: [media]",
    });
    // Only what the owner sent moves the keep-in-touch clock.
    expect(one("SELECT last_interaction_at, next_touch_at FROM contacts WHERE id = ?", id.chris)).toEqual({
      last_interaction_at: Date.parse("2026-11-17T09:16:40Z"),
      next_touch_at: Date.parse("2026-11-17T09:16:40Z") + 30 * DAY,
    });
    expect(rows("SELECT kind, status FROM sync_runs")).toEqual([{ kind: "whatsapp_export", status: "success" }]);
  });

  it("uploading the same file again adds nothing; a longer export adds only what is new", () => {
    link();
    wa.importWhatsAppExport(id.chris, strToU8(EXPORT), "_chat.txt", {}, NOW);
    expect(wa.importWhatsAppExport(id.chris, strToU8(EXPORT), "_chat.txt", {}, NOW)).toMatchObject({ ok: true, added: 0, alreadyThere: 6 });
    const longer = `${EXPORT}\n[19/11/2026, 08:00:00] Baptiste G: See you at 5`;
    expect(wa.importWhatsAppExport(id.chris, zipSync({ "_chat.txt": strToU8(longer), "photo.jpg": new Uint8Array([1, 2]) }), "WhatsApp Chat - John.zip", {}, NOW)).toMatchObject({ ok: true, added: 1, alreadyThere: 6 });
    expect(one("SELECT count(*) AS n FROM whatsapp_messages")).toEqual({ n: 7 });
    expect(timeline()).toHaveLength(3);
  });

  it("asks who is who when the saved name is not in the file, and takes the answer", () => {
    link(id.chris, "+44 7911 123456", "Johnny");
    const asked = wa.importWhatsAppExport(id.chris, strToU8(EXPORT), "_chat.txt", {}, NOW);
    expect(asked).toEqual({ ok: false, error: 'Nobody in this file is called "Johnny". Choose which name is theirs.', senders: ["John", "Baptiste G"] });
    expect(one("SELECT count(*) AS n FROM whatsapp_messages")).toEqual({ n: 0 });
    expect(wa.importWhatsAppExport(id.chris, strToU8(EXPORT), "_chat.txt", { theirName: "John" }, NOW)).toMatchObject({ ok: true, added: 6 });
    expect(rows("SELECT direction, count(*) AS n FROM whatsapp_messages GROUP BY direction ORDER BY direction")).toEqual([
      { direction: "inbound", n: 5 },
      { direction: "outbound", n: 1 },
    ]);
  });

  it("refuses a group export, a file that is not an export, dates in the future, and a contact with no link", () => {
    expect(wa.importWhatsAppExport(id.chris, strToU8(EXPORT), "_chat.txt", {}, NOW)).toEqual({ ok: false, error: "Link this contact's WhatsApp chat first." });
    link();
    const group = "[17/11/2026, 09:00:00] John: a\n[17/11/2026, 09:01:00] Maya: b\n[17/11/2026, 09:02:00] Baptiste G: c";
    expect(wa.importWhatsAppExport(id.chris, strToU8(group), "_chat.txt", {}, NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/Group chats are not imported/) });
    expect(wa.importWhatsAppExport(id.chris, strToU8("hello"), "notes.txt", {}, NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/does not look like/) });
    expect(wa.importWhatsAppExport(id.chris, strToU8("[17/11/2031, 09:00:00] John: from the future"), "_chat.txt", {}, NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/dated in the future/) });
    expect(one("SELECT count(*) AS n FROM whatsapp_messages")).toEqual({ n: 0 });
    expect(timeline()).toEqual([]);
  });
});

describe("the collector's contract", () => {
  function enable(contactId = id.chris, syncFrom: number | null = null) {
    const res = wa.updateWhatsAppLink(contactId, { syncEnabled: true, syncFrom }, NOW);
    if (!res.ok) throw new Error(res.error);
  }

  it("is closed until a token exists, and compares it in constant time", () => {
    expect(wa.collectorTokenMatches(null)).toBe(false);
    expect(wa.collectorTokenMatches("")).toBe(false);
    expect(wa.collectorTokenMatches("anything")).toBe(false);
    const token = wa.rotateCollectorToken();
    expect(wa.collectorTokenMatches(token)).toBe(true);
    expect(wa.collectorTokenMatches(`${token}x`)).toBe(false);
    expect(wa.collectorTokenMatches(token.slice(0, -1))).toBe(false);
  });

  it("asks only for people whose sync is on: a number and dates, never a name", () => {
    link();
    wa.linkWhatsApp(id.maya, { number: "+33 6 12 34 56 78", savedName: "Maya O" }, NOW - 10 * DAY);
    expect(wa.collectorWants(NOW)).toEqual([]);
    enable();
    const wants = wa.collectorWants(NOW);
    expect(wants).toEqual([{ waId: "447911123456", from: NOW - 10 * DAY, to: null }]);
    expect(JSON.stringify(wants)).not.toMatch(/John|Chris|Maya|33612345678/);
    expect(wa.collectorLastSeenAt()).toBe(NOW);
  });

  it("stores what was asked for and discards, unread, what was not", () => {
    link();
    wa.linkWhatsApp(id.maya, { number: "+33 6 12 34 56 78", savedName: "Maya O" }, NOW - 10 * DAY);
    enable();
    const delivery = wa.collectorDeliver(
      [
        { waId: "447911123456", coveredFrom: NOW - 10 * DAY, coveredTo: NOW, messages: [m("3EB0A", 30, "outbound", "Coffee Thursday?"), m("3EB0B", 20, "inbound", "Yes!")] },
        // Linked, but sync is off.
        { waId: "33612345678", coveredFrom: NOW - DAY, coveredTo: NOW, messages: [m("X1", 10, "inbound", "MAYA-PRIVATE-TEXT")] },
        // Never linked.
        { waId: "14155552671", coveredFrom: NOW - DAY, coveredTo: NOW, messages: [m("X2", 10, "inbound", "STRANGER-PRIVATE-TEXT")] },
        // A group id is not a number at all.
        { waId: "120363041234567890@g.us", coveredFrom: NOW - DAY, coveredTo: NOW, messages: [m("X3", 10, "inbound", "GROUP-PRIVATE-TEXT")] },
      ],
      NOW
    );
    expect(delivery).toEqual({ accepted: 2, alreadyThere: 0, updated: 0, refusedChats: 3 });
    const everything = JSON.stringify([rows("SELECT * FROM whatsapp_messages"), rows("SELECT * FROM interactions"), rows("SELECT * FROM sync_runs")]);
    expect(everything).not.toMatch(/PRIVATE-TEXT/);
    expect(rows("SELECT body FROM whatsapp_messages ORDER BY sent_at")).toEqual([{ body: "Coffee Thursday?" }, { body: "Yes!" }]);
    expect(timeline(id.maya)).toEqual([]);
    // The refusal is loud: it is on the sync log as a failure.
    expect(rows("SELECT kind, status, error FROM sync_runs")).toEqual([
      { kind: "whatsapp_sync", status: "failed", error: expect.stringMatching(/3 chat\(s\) that are not linked/) },
    ]);
  });

  it("\"message him and see it\": on the timeline, clock reset, and the same delivery again changes nothing", () => {
    link();
    enable();
    const chat = { waId: "447911123456", coveredFrom: NOW - 10 * DAY, coveredTo: NOW, messages: [m("3EB0A", 5, "outbound", "Coffee Thursday?")] };
    expect(wa.collectorDeliver([chat], NOW)).toMatchObject({ accepted: 1 });
    expect(timeline().map((r) => [r.title, r.counts_for_touch])).toEqual([["WhatsApp · 1 message sent", 1]]);
    expect(one("SELECT last_interaction_at FROM contacts WHERE id = ?", id.chris)).toEqual({ last_interaction_at: NOW - 5 * MINUTE });
    const before = JSON.stringify([rows("SELECT * FROM whatsapp_messages"), rows("SELECT * FROM interactions")]);
    expect(wa.collectorDeliver([chat, chat], NOW + MINUTE)).toMatchObject({ accepted: 0, alreadyThere: 2 });
    expect(JSON.stringify([rows("SELECT * FROM whatsapp_messages"), rows("SELECT * FROM interactions")])).toBe(before);
    expect(one("SELECT last_synced_at, collector_covered_from FROM whatsapp_links")).toEqual({ last_synced_at: NOW + MINUTE, collector_covered_from: NOW - 10 * DAY });
    // Next time, only the tail is asked for.
    expect(wa.collectorWants(NOW + 2 * MINUTE)).toEqual([{ waId: "447911123456", from: NOW - 15 * MINUTE, to: null }]);
  });

  it("toggling off stops it: nothing is asked for, and a late delivery is discarded", () => {
    link();
    enable();
    wa.updateWhatsAppLink(id.chris, { syncEnabled: false }, NOW);
    expect(wa.collectorWants(NOW)).toEqual([]);
    expect(wa.collectorDeliver([{ waId: "447911123456", coveredFrom: NOW - DAY, coveredTo: NOW, messages: [m("LATE", 1, "inbound", "after toggling off")] }], NOW)).toMatchObject({ accepted: 0, refusedChats: 1 });
    expect(one("SELECT count(*) AS n FROM whatsapp_messages")).toEqual({ n: 0 });
  });

  it("\"import history from\" a date asks for exactly that stretch, and nothing older is kept", () => {
    link();
    enable();
    wa.collectorDeliver([{ waId: "447911123456", coveredFrom: NOW - 10 * DAY, coveredTo: NOW, messages: [m("A", 60, "inbound")] }], NOW);
    expect(wa.updateWhatsAppLink(id.chris, { syncFrom: NOW + DAY }, NOW)).toEqual({ ok: false, error: expect.stringMatching(/in the past/) });
    wa.updateWhatsAppLink(id.chris, { syncFrom: NOW - 60 * DAY }, NOW);
    expect(wa.collectorWants(NOW)).toEqual([
      { waId: "447911123456", from: NOW - 60 * DAY, to: NOW - 10 * DAY },
      { waId: "447911123456", from: NOW - 60 * MINUTE - 10 * MINUTE, to: null },
    ]);
    const delivered = wa.collectorDeliver(
      [{ waId: "447911123456", coveredFrom: NOW - 400 * DAY, coveredTo: NOW - 10 * DAY, messages: [m("OLD", 50 * 24 * 60, "outbound", "wanted"), m("ANCIENT", 300 * 24 * 60, "outbound", "older than asked")] }],
      NOW
    );
    expect(delivered).toMatchObject({ accepted: 1 });
    expect(rows("SELECT body FROM whatsapp_messages ORDER BY sent_at")).toEqual([{ body: "wanted" }, { body: "hello" }]);
    expect(one("SELECT collector_covered_from FROM whatsapp_links")).toEqual({ collector_covered_from: NOW - 60 * DAY });
    expect(wa.collectorWants(NOW)).toHaveLength(1);
  });

  it("an edit made in WhatsApp reaches Rolo; a message repeated inside one delivery is stored once", () => {
    link();
    enable();
    const chat = (body: string) => ({ waId: "447911123456", coveredFrom: NOW - DAY, coveredTo: NOW, messages: [m("E1", 5, "outbound", body), m("E1", 5, "outbound", body)] });
    expect(wa.collectorDeliver([chat("See you at 5")], NOW)).toMatchObject({ accepted: 1, alreadyThere: 1 });
    expect(wa.collectorDeliver([chat("See you at 6")], NOW)).toMatchObject({ accepted: 0, updated: 1, alreadyThere: 1 });
    expect(rows("SELECT body FROM whatsapp_messages")).toEqual([{ body: "See you at 6" }]);
    expect(JSON.parse(timeline()[0].meta).body).toBe("You: See you at 6");
  });
});

describe("two sources, one conversation", () => {
  it("an export of messages the collector already delivered adds nothing, and the other way round", () => {
    link();
    wa.updateWhatsAppLink(id.chris, { syncEnabled: true, syncFrom: Date.parse("2026-11-01T00:00:00Z") }, NOW);
    wa.collectorDeliver(
      [{ waId: "447911123456", coveredFrom: NOW - 20 * DAY, coveredTo: NOW, messages: [
        { key: "C1", direction: "inbound", sentAt: Date.parse("2026-11-17T09:15:02Z"), kind: "text", body: "Morning! Still on for Thursday?" },
        { key: "C2", direction: "outbound", sentAt: Date.parse("2026-11-17T09:16:40Z"), kind: "text", body: "Yes — 5pm at the usual place" },
      ] }],
      NOW
    );
    expect(wa.importWhatsAppExport(id.chris, strToU8(EXPORT), "_chat.txt", {}, NOW)).toMatchObject({ ok: true, added: 4, alreadyThere: 2 });
    // The collector then catches up on the rest: all already there, including both "ok"s.
    const rest = wa.collectorDeliver(
      [{ waId: "447911123456", coveredFrom: NOW - 20 * DAY, coveredTo: NOW, messages: [
        { key: "C3", direction: "inbound", sentAt: Date.parse("2026-11-17T09:17:05Z"), kind: "media", body: null },
        { key: "C4", direction: "inbound", sentAt: Date.parse("2026-11-18T21:02:11Z"), kind: "text", body: "Running late" },
        { key: "C5", direction: "inbound", sentAt: Date.parse("2026-11-18T21:02:11Z"), kind: "text", body: "ok" },
        { key: "C6", direction: "inbound", sentAt: Date.parse("2026-11-18T21:02:11Z"), kind: "text", body: "ok" },
        { key: "C7", direction: "inbound", sentAt: Date.parse("2026-11-18T21:02:11Z"), kind: "text", body: "ok" },
      ] }],
      NOW
    );
    // Three "ok"s from the collector against two in the export: the third is new.
    expect(rest).toMatchObject({ accepted: 1, alreadyThere: 4 });
    expect(one("SELECT count(*) AS n FROM whatsapp_messages")).toEqual({ n: 7 });
  });
});

describe("the rolling summary and retention", () => {
  const OLD = 120 * 24 * 60; // minutes: 120 days ago
  const SUMMARY = "Chris and I have been planning a regular coffee. He is moving from MCD Capital to a larger fund in January and offered an intro to their TMT team. I owe him the deck.";

  function seed() {
    const l = link();
    wa.ingestWhatsAppMessages(l, [m("OLD1", OLD, "outbound", "old one"), m("OLD2", OLD - 5, "inbound", "old two"), m("MID", 95 * 24 * 60, "inbound", "ninety-five days"), m("NEW", 60, "outbound", "recent")], "export", NOW);
    return l;
  }
  const bodies = () => rows<{ message_key: string; body: string | null; purge_after: number | null; body_purged_at: number | null }>("SELECT message_key, body, purge_after, body_purged_at FROM whatsapp_messages ORDER BY sent_at");

  it("text is never cleared on age alone: with no summary, a year-old message keeps its words", () => {
    seed();
    expect(wa.runWhatsAppRetention(NOW + 400 * DAY)).toEqual({ scheduled: 0, unscheduled: 0, cleared: 0 });
    expect(bodies().every((b) => b.body !== null && b.purge_after === null)).toBe(true);
  });

  it("a summary must be real, move forward, and cover only what exists", () => {
    seed();
    expect(wa.saveWhatsAppSummary(id.maya, SUMMARY, NOW, NOW)).toEqual({ ok: false, error: expect.stringMatching(/No WhatsApp chat/) });
    expect(wa.saveWhatsAppSummary(id.chris, "ok", NOW - 100 * DAY, NOW)).toEqual({ ok: false, error: expect.stringMatching(/shorter than 80/) });
    expect(wa.saveWhatsAppSummary(id.chris, SUMMARY, NOW + DAY, NOW)).toEqual({ ok: false, error: expect.stringMatching(/later than the newest message/) });
    expect(wa.saveWhatsAppSummary(id.chris, SUMMARY, NOW - 100 * DAY, NOW)).toMatchObject({ ok: true, coversThrough: NOW - 100 * DAY });
    expect(wa.saveWhatsAppSummary(id.chris, SUMMARY, NOW - 110 * DAY, NOW + 1000)).toEqual({ ok: false, error: expect.stringMatching(/only moves forward/) });
    expect(one("SELECT summary_md, summary_covers_through, summary_prev_md FROM whatsapp_links")).toEqual({ summary_md: SUMMARY, summary_covers_through: NOW - 100 * DAY, summary_prev_md: null });
  });

  it("clears only text that is both past 90 days and inside the summary — and only a week after that", () => {
    seed();
    // Covers the two 120-day-old messages, not the 95-day-old one.
    wa.saveWhatsAppSummary(id.chris, SUMMARY, NOW - 100 * DAY, NOW);
    expect(wa.runWhatsAppRetention(NOW)).toEqual({ scheduled: 2, unscheduled: 0, cleared: 0 });
    expect(bodies().map((b) => [b.message_key, b.body !== null, b.purge_after])).toEqual([
      ["OLD1", true, NOW + 7 * DAY],
      ["OLD2", true, NOW + 7 * DAY],
      ["MID", true, null],
      ["NEW", true, null],
    ]);
    // Six days on: still there.
    expect(wa.runWhatsAppRetention(NOW + 6 * DAY)).toEqual({ scheduled: 0, unscheduled: 0, cleared: 0 });
    expect(bodies()[0].body).toBe("old one");
    // A week on: cleared — and only those two.
    expect(wa.runWhatsAppRetention(NOW + 7 * DAY)).toEqual({ scheduled: 0, unscheduled: 0, cleared: 2 });
    expect(bodies().map((b) => [b.message_key, b.body])).toEqual([["OLD1", null], ["OLD2", null], ["MID", "ninety-five days"], ["NEW", "recent"]]);
    // The rows stay: the day is still on the timeline, without its words.
    const old = timeline()[0];
    expect(old.title).toBe("WhatsApp · 2 messages (1 sent, 1 received)");
    expect(JSON.parse(old.meta).body).toBeUndefined();
    expect(old.counts_for_touch).toBe(1);
  });

  it("purged text does not come back when the same history is imported again", () => {
    const l = seed();
    wa.saveWhatsAppSummary(id.chris, SUMMARY, NOW - 100 * DAY, NOW);
    wa.runWhatsAppRetention(NOW);
    wa.runWhatsAppRetention(NOW + 7 * DAY);
    // The same export again, and the collector's copy under its own ids.
    expect(wa.ingestWhatsAppMessages(l, [m("OLD1", OLD, "outbound", "old one"), m("OLD2", OLD - 5, "inbound", "old two")], "export", NOW + 8 * DAY)).toMatchObject({ added: 0, alreadyThere: 2 });
    expect(wa.ingestWhatsAppMessages(l, [m("WA-ID-1", OLD, "outbound", "old one"), m("WA-ID-2", OLD - 5, "inbound", "old two")], "collector", NOW + 8 * DAY)).toMatchObject({ added: 0, alreadyThere: 2 });
    expect(bodies().slice(0, 2).map((b) => b.body)).toEqual([null, null]);
    expect(one("SELECT count(*) AS n FROM whatsapp_messages")).toEqual({ n: 4 });
  });

  it("undoing a summary takes its text off the clearing list at once, and restores the one before", () => {
    seed();
    // The first summary reaches OLD1 (120 days ago) but stops short of OLD2, five minutes later.
    const firstCovers = NOW - OLD * MINUTE + 2 * MINUTE;
    const first = wa.saveWhatsAppSummary(id.chris, SUMMARY, firstCovers, NOW - DAY);
    if (!first.ok) throw new Error(first.error);
    const second = wa.saveWhatsAppSummary(id.chris, `${SUMMARY} Updated.`, NOW - 100 * DAY, NOW);
    if (!second.ok) throw new Error(second.error);
    wa.runWhatsAppRetention(NOW);
    expect(bodies().filter((b) => b.purge_after !== null).map((b) => b.message_key)).toEqual(["OLD1", "OLD2"]);
    // Only the latest update can be undone.
    expect(wa.undoWhatsAppSummary(second.linkId, first.updatedAt, NOW)).toEqual({ ok: false, error: expect.stringMatching(/updated since/) });
    expect(wa.undoWhatsAppSummary(second.linkId, second.updatedAt, NOW + 1000)).toEqual({ ok: true });
    expect(one("SELECT summary_md, summary_covers_through FROM whatsapp_links")).toEqual({ summary_md: SUMMARY, summary_covers_through: firstCovers });
    // OLD2 is past the restored coverage: off the list. OLD1 is still inside it.
    expect(bodies().filter((b) => b.purge_after !== null).map((b) => b.message_key)).toEqual(["OLD1"]);
    wa.runWhatsAppRetention(NOW + 30 * DAY);
    expect(bodies().map((b) => [b.message_key, b.body !== null])).toEqual([["OLD1", false], ["OLD2", true], ["MID", true], ["NEW", true]]);
  });

  it("says what is waiting to be summarised", () => {
    const l = seed();
    expect(wa.whatsAppOverview(l)).toMatchObject({ messages: 4, withText: 4, unsummarised: 4, unsummarisedFrom: NOW - OLD * MINUTE, scheduledForClearing: 0 });
    wa.saveWhatsAppSummary(id.chris, SUMMARY, NOW - 100 * DAY, NOW);
    wa.runWhatsAppRetention(NOW);
    expect(wa.whatsAppOverview(wa.getWhatsAppLink(id.chris)!)).toMatchObject({ unsummarised: 2, unsummarisedFrom: NOW - 95 * DAY, scheduledForClearing: 2 });
    expect(wa.listWhatsAppLinks().map((x) => [x.contactName, x.messages])).toEqual([["Chris Haswani", 4]]);
  });
});

describe("deleting WhatsApp data", () => {
  it("removes what came from WhatsApp for that person — summary included — and nothing else", () => {
    const l = link();
    const mayaLink = wa.linkWhatsApp(id.maya, { number: "+33 6 12 34 56 78", savedName: "Maya O" }, NOW);
    if (!mayaLink.ok) throw new Error(mayaLink.error);
    wa.importWhatsAppExport(id.chris, strToU8(EXPORT), "_chat.txt", {}, NOW);
    wa.ingestWhatsAppMessages(mayaLink.link, [m("M1", 10, "outbound", "hi Maya")], "export", NOW);
    wa.saveWhatsAppSummary(id.chris, "x".repeat(100), Date.parse("2026-11-18T21:02:11Z"), NOW);
    expect(wa.deleteWhatsAppData(id.chris)).toEqual({ ok: true, messages: 6, timelineRows: 2 });
    expect(rows("SELECT contact_id FROM whatsapp_links")).toEqual([{ contact_id: id.maya }]);
    expect(rows("SELECT link_id FROM whatsapp_messages")).toEqual([{ link_id: mayaLink.link.id }]);
    expect(timeline()).toEqual([]);
    expect(timeline(id.maya)).toHaveLength(1);
    // Chris himself, his note and his hand-logged catch-up are untouched,
    // and the clock is back to what they alone say.
    expect(one("SELECT display_name, last_interaction_at, next_touch_at FROM contacts WHERE id = ?", id.chris)).toEqual({
      display_name: "Chris Haswani",
      last_interaction_at: NOW - 40 * DAY,
      next_touch_at: NOW - 10 * DAY,
    });
    expect(rows("SELECT body_md FROM notes WHERE contact_id = ?", id.chris)).toEqual([{ body_md: "Met at LBS." }]);
    expect(rows("SELECT source FROM interactions WHERE contact_id = ?", id.chris)).toEqual([{ source: "user" }]);
    expect(wa.deleteWhatsAppData(id.chris)).toEqual({ ok: false, error: expect.stringMatching(/No WhatsApp chat/) });
    void l;
  });

  it("deleting the contact takes their WhatsApp data with them", () => {
    link();
    wa.importWhatsAppExport(id.chris, strToU8(EXPORT), "_chat.txt", {}, NOW);
    rawDb.prepare("DELETE FROM contacts WHERE id = ?").run(id.chris);
    expect(one("SELECT (SELECT count(*) FROM whatsapp_links) AS links, (SELECT count(*) FROM whatsapp_messages) AS messages")).toEqual({ links: 0, messages: 0 });
  });

  it("renaming the saved name rewrites the transcripts, not the identity", () => {
    link();
    wa.importWhatsAppExport(id.chris, strToU8(EXPORT), "_chat.txt", {}, NOW);
    expect(wa.updateWhatsAppLink(id.chris, { savedName: "Chris H" }, NOW)).toMatchObject({ ok: true, link: { savedName: "Chris H", waId: "447911123456" } });
    expect(JSON.parse(timeline()[1].meta).body).toBe("Chris H: Running late\nChris H: ok\nChris H: ok");
    expect(wa.updateWhatsAppLink(id.chris, { savedName: " " }, NOW)).toEqual({ ok: false, error: expect.stringMatching(/cannot be empty/) });
  });
});
