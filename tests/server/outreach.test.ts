import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// SPEC §16: the outreach loop against a real database — campaigns, the
// derived pipeline, drafts to send, Today's "awaiting reply", the voice
// guide, and the connector tools an agent drives it all with.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const NOW = Date.now();

let dataDir: string;
let rawDb: import("better-sqlite3").Database;
let out: typeof import("@/server/outreach-core");
let tools: typeof import("@/server/agent/tools");
let today: typeof import("@/server/today-data");
const id: Record<string, number> = {};
const ACCOUNT = { provider: "google", account_email: "owner@gmail.test", scopes: "calendar", status: "active", created_at: NOW, updated_at: NOW };

function ins(table: string, row: Record<string, unknown>): number {
  const keys = Object.keys(row);
  return Number(rawDb.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row)).lastInsertRowid);
}
const rows = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => rawDb.prepare(sql).all(...p) as T[];
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => rawDb.prepare(sql).get(...p) as T;

function contact(name: string, extra: Record<string, unknown> = {}, email?: string): number {
  const [first, ...rest] = name.split(" ");
  const cid = ins("contacts", { first_name: first, last_name: rest.join(" ") || null, display_name: name, created_at: NOW - 200 * DAY, updated_at: NOW - 200 * DAY, ...extra });
  if (email) ins("contact_emails", { contact_id: cid, email, email_normalized: email.toLowerCase(), source: "linkedin", created_at: NOW - 200 * DAY });
  return cid;
}
function exchange(contactId: number, direction: "inbound" | "outbound", daysAgo: number, title = "Coffee?", extra: Record<string, unknown> = {}): number {
  return ins("interactions", { contact_id: contactId, kind: "email", direction, occurred_at: NOW - daysAgo * DAY, title, source: "gmail", source_key: `k${Math.random()}`, counts_for_touch: direction === "outbound" ? 1 : 0, created_at: NOW, ...extra });
}

type Out = Record<string, unknown> & { error?: string; actionId?: number };
function call(name: string, args: unknown = {}, scopes = ["read", "write"]): { isError: boolean; data: Out; text: string } {
  const res = tools.callAgentTool(name, args, { grantId: null, scopes, now: NOW });
  return { isError: res.isError, data: JSON.parse(res.text) as Out, text: res.text };
}
function ok(name: string, args: unknown = {}): Out {
  const res = call(name, args);
  expect(res.isError, `${name} → ${res.text.slice(0, 300)}`).toBe(false);
  return res.data;
}
function refused(name: string, args: unknown = {}, scopes = ["read", "write"]): string {
  const res = call(name, args, scopes);
  expect(res.isError, `${name} → ${res.text.slice(0, 300)}`).toBe(true);
  return String(res.data.error);
}
function campaign(members: number[] = [], startedDaysAgo = 20): number {
  const res = out.saveCampaign({ name: "TMT banking", goal: "Coffee chats with TMT bankers", briefMd: "Top firms; LBS angle.", startedAt: NOW - startedDaysAgo * DAY }, NOW - startedDaysAgo * DAY);
  if (!res.ok) throw new Error(res.error);
  for (const m of members) ins("group_members", { group_id: res.groupId, contact_id: m, created_at: NOW });
  return res.groupId;
}
const stageOf = (groupId: number, contactId: number) => out.campaignPipeline(groupId, NOW)!.members.find((m) => m.contactId === contactId)!;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rolo-outreach-"));
  process.env.ROLO_DATA_DIR = dataDir;
  const client = await import("@/db/client");
  rawDb = client.rawDb;
  migrate(client.db, { migrationsFolder: path.join(__dirname, "../../src/db/migrations") });
  out = await import("@/server/outreach-core");
  tools = await import("@/server/agent/tools");
  today = await import("@/server/today-data");
});

beforeEach(() => {
  for (const t of ["agent_calls", "contacts", "groups", "tags", "reminders", "calendar_events", "settings"]) rawDb.prepare(`DELETE FROM ${t}`).run();
  ins("settings", { key: "timezone", value: JSON.stringify("Europe/London") });
  rawDb.prepare("DELETE FROM integration_accounts").run();
  id.account = ins("integration_accounts", ACCOUNT);
  id.ana = contact("Ana Silva", { title: "Vice President", company: "Goldman Sachs" }, "ana.silva@gs.test");
  id.ben = contact("Ben Okafor", { title: "Analyst", company: "Lazard" });
  id.cara = contact("Cara Lin", { title: "Associate", company: "Evercore" }, "cara.lin@evercore.test");
});

afterAll(() => {
  rawDb?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("campaigns", () => {
  it("a campaign is a group plus a brief — nothing is stored per person", () => {
    const groupId = campaign([id.ana, id.ben]);
    expect(rows("SELECT name FROM groups")).toEqual([{ name: "TMT banking" }]);
    expect(out.getCampaign(groupId)).toMatchObject({ name: "TMT banking", goal: "Coffee chats with TMT bankers", briefMd: "Top firms; LBS angle.", archivedAt: null });
    const listed = out.listCampaigns(NOW);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ groupId, members: 2 });
    expect(listed[0].byStage.not_contacted).toBe(2);
    // No table knows anyone's stage: only the group membership exists.
    expect(rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%campaign%'")).toEqual([]);
  });

  it("refuses a campaign with no goal, a taken name, a missing group, or a start in the future", () => {
    expect(out.saveCampaign({ name: "X", goal: "  " })).toMatchObject({ ok: false, error: expect.stringMatching(/needs a goal/) });
    expect(out.saveCampaign({ goal: "A goal" })).toMatchObject({ ok: false, error: expect.stringMatching(/needs a name/) });
    campaign();
    expect(out.saveCampaign({ name: "tmt BANKING", goal: "Again" })).toMatchObject({ ok: false, error: expect.stringMatching(/already exists/) });
    expect(out.saveCampaign({ groupId: 99999, goal: "A goal" })).toMatchObject({ ok: false, error: expect.stringMatching(/no group/) });
    expect(out.saveCampaign({ name: "Later", goal: "A goal", startedAt: NOW + 5 * DAY }, NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/future/) });
    expect(rows("SELECT name FROM groups")).toEqual([{ name: "TMT banking" }]);
  });

  it("an existing group becomes a campaign; a deleted group takes its campaign with it", () => {
    const groupId = ins("groups", { name: "LBS alumni", created_at: NOW });
    expect(out.saveCampaign({ groupId, goal: "Reconnect with alumni" }, NOW)).toMatchObject({ ok: true, createdGroup: false, createdCampaign: true });
    expect(out.listCampaignRecords().map((c) => c.name)).toEqual(["LBS alumni"]);
    rawDb.prepare("DELETE FROM groups WHERE id = ?").run(groupId);
    expect(out.listCampaignRecords()).toEqual([]);
    expect(out.campaignPipeline(groupId, NOW)).toBeNull();
    // SQLite gives the freed id to the next group. It is not a campaign, and
    // making it one starts clean rather than inheriting the old brief.
    const reused = ins("groups", { name: "Family", created_at: NOW + 1000 });
    expect(reused).toBe(groupId);
    expect(out.listCampaignRecords()).toEqual([]);
    expect(out.saveCampaign({ groupId: reused, goal: "See them more" }, NOW + 2000)).toMatchObject({ ok: true, createdCampaign: true });
    expect(out.getCampaign(reused)).toMatchObject({ name: "Family", goal: "See them more", briefMd: "", prev: null });
  });

  it("counts from the day the outreach began, which the owner can move back", () => {
    const groupId = campaign([id.ana], 5);
    exchange(id.ana, "outbound", 9);
    expect(stageOf(groupId, id.ana)).toMatchObject({ stage: "not_contacted" });
    const day = new Date(NOW - 12 * DAY).toISOString().slice(0, 10);
    const startedAt = out.startOfLocalDay(day);
    expect(startedAt).not.toBeNull();
    expect(out.startOfLocalDay("2026-02-31")).toBeNull();
    expect(out.startOfLocalDay("yesterday")).toBeNull();
    out.saveCampaign({ groupId, goal: "Coffee chats with TMT bankers", briefMd: "Top firms; LBS angle.", startedAt: startedAt! }, NOW);
    expect(stageOf(groupId, id.ana)).toMatchObject({ stage: "awaiting_reply", daysWaiting: 9 });
  });

  it("archiving takes it off Today without losing anything", () => {
    const groupId = campaign([id.ana]);
    exchange(id.ana, "outbound", 9);
    expect(out.awaitingReply(NOW).map((a) => a.name)).toEqual(["Ana Silva"]);
    expect(out.setCampaignArchived(groupId, true, NOW)).toEqual({ ok: true });
    expect(out.awaitingReply(NOW)).toEqual([]);
    expect(out.campaignPipeline(groupId, NOW)!.members).toHaveLength(1);
    out.setCampaignArchived(groupId, false, NOW);
    expect(out.awaitingReply(NOW)).toHaveLength(1);
  });
});

describe("where each person stands, read off the timeline", () => {
  it("walks a real outreach: nothing → draft → sent → nudge due → nudged → reply → call booked → met", () => {
    const groupId = campaign([id.ana]);
    expect(stageOf(groupId, id.ana)).toMatchObject({ stage: "not_contacted", email: "ana.silva@gs.test" });

    const draft = out.saveDraft({ contactId: id.ana, groupId, kind: "first", subject: "LBS student — 15 minutes?", body: "Dear Ana…", source: "agent" }, NOW - 12 * DAY);
    if (!draft.ok) throw new Error(draft.error);
    expect(stageOf(groupId, id.ana)).toMatchObject({ stage: "drafted", openDraftId: draft.draft.id });

    out.markDraftSent(draft.draft.id, NOW - 10 * DAY);
    expect(stageOf(groupId, id.ana)).toMatchObject({ stage: "awaiting_reply", daysWaiting: 10, nudgeDue: true, sentSinceReply: 1, openDraftId: null });

    exchange(id.ana, "outbound", 2, "Re: LBS student — 15 minutes?");
    expect(stageOf(groupId, id.ana)).toMatchObject({ stage: "awaiting_reply", daysWaiting: 2, nudgeDue: false, sentSinceReply: 2 });

    exchange(id.ana, "inbound", 1, "Re: LBS student — 15 minutes?");
    expect(stageOf(groupId, id.ana)).toMatchObject({ stage: "your_move" });

    ins("calendar_events", { event_key: "e1", account_id: id.account, summary: "Call with Ana", starts_at: NOW + 2 * DAY, status: "confirmed", attendees: JSON.stringify([{ email: "ana.silva@gs.test", name: "Ana", contactId: id.ana }]), updated_at: NOW });
    expect(stageOf(groupId, id.ana)).toMatchObject({ stage: "call_booked", callAt: NOW + 2 * DAY });

    rawDb.prepare("DELETE FROM calendar_events").run();
    ins("interactions", { contact_id: id.ana, kind: "meeting", occurred_at: NOW - 60 * MINUTE, title: "Call with Ana", source: "calendar", counts_for_touch: 1, created_at: NOW });
    expect(stageOf(groupId, id.ana)).toMatchObject({ stage: "met" });
  });

  it("a cancelled meeting books nothing; the tags say what no message can", () => {
    const groupId = campaign([id.ana, id.cara]);
    exchange(id.ana, "outbound", 3);
    ins("calendar_events", { event_key: "e2", account_id: id.account, summary: "Cancelled", starts_at: NOW + DAY, status: "cancelled", attendees: JSON.stringify([{ contactId: id.ana }]), updated_at: NOW });
    expect(stageOf(groupId, id.ana).stage).toBe("awaiting_reply");
    const bad = ins("tags", { name: "Bad Address", color: "#888", created_at: NOW });
    const no = ins("tags", { name: "not pursuing", color: "#888", created_at: NOW });
    ins("contact_tags", { contact_id: id.ana, tag_id: bad, created_at: NOW });
    ins("contact_tags", { contact_id: id.cara, tag_id: no, created_at: NOW });
    expect(stageOf(groupId, id.ana).stage).toBe("bad_address");
    expect(stageOf(groupId, id.cara).stage).toBe("not_pursuing");
  });

  it("WhatsApp counts message by message, so a reply later the same day is a reply", async () => {
    const wa = await import("@/server/whatsapp-core");
    const groupId = campaign([id.ben]);
    const linked = wa.linkWhatsApp(id.ben, { number: "+44 7911 123456", savedName: "Ben" }, NOW - 5 * DAY);
    if (!linked.ok) throw new Error(linked.error);
    wa.ingestWhatsAppMessages(linked.link, [{ key: "a", direction: "outbound", sentAt: NOW - 3 * 60 * MINUTE, kind: "text", body: "Coffee next week?" }], "export", NOW);
    expect(stageOf(groupId, id.ben).stage).toBe("awaiting_reply");
    wa.ingestWhatsAppMessages(linked.link, [{ key: "b", direction: "inbound", sentAt: NOW - 60 * MINUTE, kind: "text", body: "Yes!" }], "export", NOW);
    // One timeline row for the day, dated to the owner's message — but the stage knows who wrote last.
    expect(rows("SELECT direction FROM interactions WHERE source = 'whatsapp'")).toEqual([{ direction: "outbound" }]);
    expect(stageOf(groupId, id.ben).stage).toBe("your_move");
  });

  it("archived contacts drop out; people outside the campaign are never in it", () => {
    const groupId = campaign([id.ana, id.ben]);
    rawDb.prepare("UPDATE contacts SET archived_at = ? WHERE id = ?").run(NOW, id.ben);
    expect(out.campaignPipeline(groupId, NOW)!.members.map((m) => m.name)).toEqual(["Ana Silva"]);
  });
});

describe("drafts to send", () => {
  const draftFor = (contactId: number, groupId: number | null, over: Record<string, unknown> = {}) =>
    out.saveDraft({ contactId, groupId, kind: "first", subject: "LBS student — 15 minutes?", body: "Dear Ana,\n\nCould we speak?\n\nBest,\nBaptiste", source: "agent", ...over } as Parameters<typeof out.saveDraft>[0], NOW - DAY);

  it("is addressed to the person's own address — never to one that is not on the contact", () => {
    const groupId = campaign([id.ana, id.ben]);
    const a = draftFor(id.ana, groupId);
    expect(a).toMatchObject({ ok: true, draft: { toEmail: "ana.silva@gs.test", status: "open", source: "agent" } });
    expect(draftFor(id.cara, groupId, { toEmail: "attacker@evil.test" })).toMatchObject({ ok: false, error: expect.stringMatching(/not an address Rolo holds for Cara Lin/) });
    expect(draftFor(id.cara, groupId, { toEmail: "CARA.LIN@evercore.test" })).toMatchObject({ ok: true, draft: { toEmail: "cara.lin@evercore.test" } });
    // Someone with no address can still be drafted for: the owner is told.
    expect(draftFor(id.ben, groupId)).toMatchObject({ ok: true, draft: { toEmail: null } });
    expect(rows("SELECT to_email FROM outreach_drafts WHERE to_email LIKE '%evil%'")).toEqual([]);
  });

  it("one waiting draft per person per campaign: a second must say which it replaces", () => {
    const groupId = campaign([id.ana]);
    const first = draftFor(id.ana, groupId);
    if (!first.ok) throw new Error(first.error);
    expect(draftFor(id.ana, groupId, { subject: "Second try" })).toMatchObject({ ok: false, existingDraftId: first.draft.id, error: expect.stringMatching(/already has a draft waiting/) });
    expect(draftFor(id.ana, groupId, { subject: "Second try", replaceDraftId: 9999 })).toMatchObject({ ok: false });
    const second = draftFor(id.ana, groupId, { subject: "Second try", replaceDraftId: first.draft.id });
    expect(second).toMatchObject({ ok: true, replacedId: first.draft.id });
    expect(rows("SELECT subject, status FROM outreach_drafts ORDER BY id")).toEqual([
      { subject: "LBS student — 15 minutes?", status: "discarded" },
      { subject: "Second try", status: "open" },
    ]);
    // A different campaign, or none, is a different slot.
    expect(draftFor(id.ana, null, { subject: "Outside any campaign" })).toMatchObject({ ok: true });
  });

  it("refuses a draft with no subject or body, an unknown person, an unknown campaign", () => {
    const groupId = campaign([id.ana]);
    expect(draftFor(id.ana, groupId, { subject: "  " })).toMatchObject({ ok: false, error: expect.stringMatching(/subject/) });
    expect(draftFor(id.ana, groupId, { body: String.fromCharCode(1, 2) })).toMatchObject({ ok: false, error: expect.stringMatching(/body/) });
    expect(draftFor(id.ana, groupId, { body: "x".repeat(6001) })).toMatchObject({ ok: false, error: expect.stringMatching(/longer than 6000/) });
    expect(draftFor(424242, groupId)).toMatchObject({ ok: false, error: expect.stringMatching(/no contact/) });
    expect(draftFor(id.ana, 424242)).toMatchObject({ ok: false, error: expect.stringMatching(/no campaign/) });
    expect(rows("SELECT id FROM outreach_drafts")).toEqual([]);
  });

  it("\"Sent\" is the record: an outbound email on the timeline, the clock reset, the draft done", () => {
    const groupId = campaign([id.ana]);
    rawDb.prepare("UPDATE contacts SET cadence_days = 30 WHERE id = ?").run(id.ana);
    const d = draftFor(id.ana, groupId);
    if (!d.ok) throw new Error(d.error);
    expect(out.editDraft(d.draft.id, { subject: "LBS student — a quick call?", body: "Dear Ana, edited." }, NOW - 60 * MINUTE)).toEqual({ ok: true });
    const sent = out.markDraftSent(d.draft.id, NOW);
    expect(sent).toMatchObject({ ok: true, contactId: id.ana });
    expect(rows("SELECT kind, direction, title, source, source_key, counts_for_touch, occurred_at FROM interactions")).toEqual([
      { kind: "email", direction: "outbound", title: "LBS student — a quick call?", source: "user", source_key: `draft:${d.draft.id}`, counts_for_touch: 1, occurred_at: NOW },
    ]);
    expect(one("SELECT status, sent_at, interaction_id IS NOT NULL AS linked FROM outreach_drafts")).toEqual({ status: "sent", sent_at: NOW, linked: 1 });
    expect(one("SELECT last_interaction_at, next_touch_at FROM contacts WHERE id = ?", id.ana)).toEqual({ last_interaction_at: NOW, next_touch_at: NOW + 30 * DAY });
    // Clicking twice, or editing or discarding afterwards, does nothing more.
    expect(out.markDraftSent(d.draft.id, NOW)).toMatchObject({ ok: false });
    expect(out.editDraft(d.draft.id, { subject: "x", body: "y" })).toMatchObject({ ok: false });
    expect(out.discardDraft(d.draft.id)).toMatchObject({ ok: false });
    expect(rows("SELECT id FROM interactions")).toHaveLength(1);
    expect(out.listDrafts({ status: "open" })).toEqual([]);
    expect(out.listDrafts({ status: "sent" }).map((x) => x.contactName)).toEqual(["Ana Silva"]);
  });

  it("a draft sent without clicking retires itself when the send is logged another way", () => {
    const groupId = campaign([id.ana, id.cara]);
    const a = draftFor(id.ana, groupId);
    const c = draftFor(id.cara, groupId, { subject: "A different subject" });
    if (!a.ok || !c.ok) throw new Error("setup");
    // The agent reads the forwarded copy of Ana's email, an hour after it was drafted.
    const logged = exchange(id.ana, "outbound", 0.5, "FW: LBS student — 15 minutes?");
    // An older email with the same subject is not this draft's send.
    exchange(id.cara, "outbound", 30, "A different subject");
    // Nor is one somebody else received.
    exchange(id.cara, "inbound", 0.2, "A different subject");
    expect(out.reconcileDrafts(NOW)).toBe(1);
    expect(rows("SELECT contact_id, status, interaction_id FROM outreach_drafts ORDER BY id")).toEqual([
      { contact_id: id.ana, status: "sent", interaction_id: logged },
      { contact_id: id.cara, status: "open", interaction_id: null },
    ]);
    expect(out.listDrafts().map((d) => d.contactName)).toEqual(["Cara Lin"]);
    expect(out.countOpenDrafts()).toBe(1);
  });

  it("discarding keeps nothing on the timeline", () => {
    const groupId = campaign([id.ana]);
    const d = draftFor(id.ana, groupId);
    if (!d.ok) throw new Error(d.error);
    expect(out.discardDraft(d.draft.id, NOW)).toMatchObject({ ok: true });
    expect(rows("SELECT id FROM interactions")).toEqual([]);
    expect(stageOf(groupId, id.ana).stage).toBe("not_contacted");
  });
});

describe("Today: awaiting reply", () => {
  it("lists campaign people a follow-up is due for, longest wait first, once each", () => {
    const groupId = campaign([id.ana, id.ben, id.cara]);
    const second = out.saveCampaign({ name: "Second campaign", goal: "Another" }, NOW - 20 * DAY);
    if (!second.ok) throw new Error(second.error);
    ins("group_members", { group_id: second.groupId, contact_id: id.ana, created_at: NOW });
    exchange(id.ana, "outbound", 9);
    exchange(id.ben, "outbound", 15);
    exchange(id.cara, "outbound", 3); // inside the week
    const contactOutside = contact("Dan Outside");
    exchange(contactOutside, "outbound", 40); // not in any campaign
    expect(out.awaitingReply(NOW).map((a) => [a.name, a.daysWaiting, a.campaignName])).toEqual([
      ["Ben Okafor", 15, "TMT banking"],
      ["Ana Silva", 9, "Second campaign"],
    ].map(([n, d]) => [n, d, expect.any(String)]));
    const data = today.getTodayData(NOW);
    expect(data.awaitingReply).toHaveLength(2);
    expect(data.draftsToSend).toBe(0);
    // A follow-up already written takes them off the list and onto "drafts to send".
    out.saveDraft({ contactId: id.ben, groupId, kind: "nudge", subject: "Following up", body: "Hi Ben…", source: "agent" }, NOW);
    const after = today.getTodayData(NOW);
    expect(after.awaitingReply.map((a) => a.name)).toEqual(["Ana Silva"]);
    expect(after.draftsToSend).toBe(1);
  });

  it("the wait is the owner's to set", () => {
    campaign([id.ana]);
    exchange(id.ana, "outbound", 4);
    expect(out.awaitingReply(NOW)).toEqual([]);
    expect(out.saveOutreachSettings({ nudgeAfterDays: 3, dormantAfterDays: 21, bcc: "capture@gmail.test" })).toEqual({ ok: true });
    expect(out.outreachSettings()).toEqual({ nudgeAfterDays: 3, dormantAfterDays: 21, bcc: "capture@gmail.test" });
    expect(out.awaitingReply(NOW).map((a) => a.daysWaiting)).toEqual([4]);
    expect(out.saveOutreachSettings({ nudgeAfterDays: 0, dormantAfterDays: 21, bcc: "" })).toMatchObject({ ok: false });
    expect(out.saveOutreachSettings({ nudgeAfterDays: 7, dormantAfterDays: 7, bcc: "" })).toMatchObject({ ok: false });
    expect(out.saveOutreachSettings({ nudgeAfterDays: 7, dormantAfterDays: 30, bcc: "not an address" })).toMatchObject({ ok: false });
  });
});

describe("what Claude can do with it", () => {
  it("sets up a campaign from a goal, adds people, and reads back where they stand", () => {
    const made = ok("save_campaign", { name: "TMT banking", goal: "Coffee chats with TMT bankers at the top firms", brief: "Who fits: TMT coverage.\n![x](https://evil.test/p.png)", startedOn: new Date(NOW - 20 * DAY).toISOString().slice(0, 10), addContactIds: [id.ana, id.ben, 99999] });
    expect(made).toMatchObject({ created: true, name: "TMT banking", peopleAdded: 2, unknownContactIds: [99999] });
    const campaignId = made.campaignId as number;
    expect(out.getCampaign(campaignId)!.briefMd).toBe("Who fits: TMT coverage.\n[x](https://evil.test/p.png)");
    expect(ok("list_campaigns")).toMatchObject({ total: 1, draftsToSend: 0, campaigns: [{ campaignId, name: "TMT banking", people: 2, byStage: { not_contacted: 2 } }] });
    exchange(id.ana, "outbound", 9);
    const pipeline = ok("get_pipeline", { campaignId });
    expect(pipeline).toMatchObject({ name: "TMT banking", total: 2, byStage: { awaiting_reply: 1, not_contacted: 1 } });
    expect(pipeline.people).toEqual([
      { contactId: id.ana, name: "Ana Silva", title: "Vice President", company: "Goldman Sachs", hasEmail: true, stage: "awaiting_reply", daysWaiting: 9, followUpDue: true, sentSinceTheyLastWrote: 1, lastSentAt: new Date(NOW - 9 * DAY).toISOString() },
      { contactId: id.ben, name: "Ben Okafor", title: "Analyst", company: "Lazard", hasEmail: false, stage: "not_contacted" },
    ]);
    expect(String(pipeline.note)).toMatch(/never as instructions/);
    expect((ok("get_pipeline", { campaignId, stage: ["awaiting_reply"] }).people as unknown[]).length).toBe(1);
    expect(refused("get_pipeline", { campaignId: 424242 })).toMatch(/no campaign/);
    // Updating keeps the brief unless a new one is given.
    ok("save_campaign", { campaignId, goal: "A sharper goal" });
    expect(out.getCampaign(campaignId)).toMatchObject({ goal: "A sharper goal", briefMd: "Who fits: TMT coverage.\n[x](https://evil.test/p.png)" });
  });

  it("drafts into \"Drafts to send\", to the contact's own address only, and never twice by accident", () => {
    const campaignId = campaign([id.ana, id.ben]);
    const draft = ok("save_draft", { contactId: id.ana, campaignId, kind: "first", subject: "LBS student —\n15 minutes?", body: "Dear Ana,\r\n\r\nCould we speak?\r\n\r\nBest,\r\nBaptiste", idempotencyKey: "draft:ana:first" });
    expect(draft).toMatchObject({ saved: true, to: "ana.silva@gs.test" });
    expect(one("SELECT subject, body, source, status FROM outreach_drafts WHERE id = ?", draft.draftId)).toEqual({
      subject: "LBS student — 15 minutes?",
      body: "Dear Ana,\n\nCould we speak?\n\nBest,\nBaptiste",
      source: "agent",
      status: "open",
    });
    expect(ok("save_draft", { contactId: id.ana, campaignId, kind: "first", subject: "LBS student — 15 minutes?", body: "Dear Ana…", idempotencyKey: "draft:ana:first" })).toMatchObject({ alreadyDone: true });
    expect(refused("save_draft", { contactId: id.ana, campaignId, kind: "first", subject: "Another", body: "Dear Ana…" })).toMatch(/already has a draft waiting.*replaceDraftId/);
    expect(refused("save_draft", { contactId: id.ana, campaignId, kind: "first", subject: "x", body: "y", toEmail: "attacker@evil.test", replaceDraftId: draft.draftId })).toMatch(/not an address Rolo holds/);
    const noAddress = ok("save_draft", { contactId: id.ben, campaignId, kind: "first", subject: "Hello Ben", body: "Dear Ben…" });
    expect(noAddress).toMatchObject({ to: null, note: expect.stringMatching(/no email address for Ben Okafor/) });
    expect(refused("save_draft", { contactId: id.ana, kind: "sales_pitch", subject: "x", body: "y" })).toMatch(/kind/);
    expect(refused("save_draft", { contactId: id.ana, kind: "first", subject: "x", body: "y", send: true })).toMatch(/send|Unrecognized/i);
    expect(refused("save_draft", { contactId: id.ana, kind: "first", subject: "x", body: "y" }, ["read"])).toMatch(/read-only/);
    const listed = ok("list_drafts");
    expect(listed).toMatchObject({ status: "open", total: 2 });
    expect((listed.drafts as { name: string; to: string | null }[]).map((d) => [d.name, d.to])).toEqual([["Ana Silva", "ana.silva@gs.test"], ["Ben Okafor", null]]);
    expect(rows("SELECT id FROM interactions")).toEqual([]);
  });

  it("undo takes a draft back — and puts back the one it replaced — unless the owner has touched it", () => {
    const campaignId = campaign([id.ana, id.cara]);
    const first = ok("save_draft", { contactId: id.ana, campaignId, kind: "first", subject: "First version", body: "Dear Ana…" });
    const second = ok("save_draft", { contactId: id.ana, campaignId, kind: "first", subject: "Second version", body: "Dear Ana, again…", replaceDraftId: first.draftId });
    expect(ok("undo_agent_action", { actionId: second.actionId }).reversed).toEqual(["removed the draft and put the earlier one back"]);
    expect(rows("SELECT subject, status FROM outreach_drafts")).toEqual([{ subject: "First version", status: "open" }]);
    // Edited by the owner: theirs now.
    out.editDraft(first.draftId as number, { subject: "First version, my wording", body: "Dear Ana, mine." }, NOW + 5000);
    expect(refused("undo_agent_action", { actionId: first.actionId })).toMatch(/edited after it was written, so it was kept/);
    // Sent: it happened.
    const cara = ok("save_draft", { contactId: id.cara, campaignId, kind: "first", subject: "Hello Cara", body: "Dear Cara…" });
    out.markDraftSent(cara.draftId as number, NOW);
    expect(refused("undo_agent_action", { actionId: cara.actionId })).toMatch(/has been sent, so it was kept/);
    expect(rows("SELECT status FROM outreach_drafts ORDER BY id")).toEqual([{ status: "open" }, { status: "sent" }]);
  });

  it("the forwarded copy of an email sent from \"Drafts to send\" is not logged a second time", () => {
    const campaignId = campaign([id.ana]);
    const draft = ok("save_draft", { contactId: id.ana, campaignId, kind: "first", subject: "LBS student — 15 minutes?", body: "Dear Ana…" });
    // The owner clicks Sent an hour and a half after the email really left.
    out.markDraftSent(draft.draftId as number, NOW - 60 * MINUTE);
    const logged = ok("log_interaction", { contactId: id.ana, kind: "email", direction: "outbound", occurredAt: new Date(NOW - 150 * MINUTE).toISOString(), subject: "FW: LBS student — 15 minutes?", category: "outreach", idempotencyKey: "gmail:forwarded-1" });
    expect(logged).toMatchObject({ logged: false, alreadyRecorded: true });
    expect(rows("SELECT id FROM interactions")).toHaveLength(1);
    // A different email to her the same day is still logged.
    expect(ok("log_interaction", { contactId: id.ana, kind: "email", direction: "outbound", occurredAt: new Date(NOW - 30 * MINUTE).toISOString(), subject: "One more thing", category: "follow_up", idempotencyKey: "gmail:other" })).toMatchObject({ logged: true });
  });

  it("a call that was arranged is a reminder at its time — and reads as \"call booked\"", () => {
    const campaignId = campaign([id.ana]);
    exchange(id.ana, "outbound", 5);
    exchange(id.ana, "inbound", 1);
    expect(refused("create_reminder", { title: "Call", dueAt: new Date(NOW + 2 * DAY).toISOString(), purpose: "call" })).toMatch(/attached to the contact/);
    const call = ok("create_reminder", { title: "Call with Ana", dueAt: new Date(NOW + 2 * DAY).toISOString(), contactId: id.ana, purpose: "call" });
    expect(stageOf(campaignId, id.ana)).toMatchObject({ stage: "call_booked", callAt: NOW + 2 * DAY });
    // An ordinary reminder books nothing.
    ok("create_reminder", { title: "Send the deck", dueAt: new Date(NOW + DAY).toISOString(), contactId: id.ana });
    expect(stageOf(campaignId, id.ana).callAt).toBe(NOW + 2 * DAY);
    // Completed, or undone, and the exchange decides again.
    ok("undo_agent_action", { actionId: call.actionId });
    expect(stageOf(campaignId, id.ana).stage).toBe("your_move");
  });

  it("undo takes back a campaign it created — group and all while empty — or the last edit", () => {
    const made = ok("save_campaign", { name: "Short-lived", goal: "A goal", addContactIds: [id.ana] });
    const campaignId = made.campaignId as number;
    const edited = ok("save_campaign", { campaignId, goal: "A second goal", brief: "A brief." });
    // Only the latest save of a campaign can be undone: the older call takes back the person it added, no more.
    expect(ok("undo_agent_action", { actionId: made.actionId })).toMatchObject({
      reversed: ["removed 1 group member"],
      leftInPlace: ["the campaign has been changed since, so it was left as it is"],
    });
    expect(ok("undo_agent_action", { actionId: edited.actionId }).reversed).toEqual(["put the campaign's previous goal and brief back"]);
    expect(out.getCampaign(campaignId)).toMatchObject({ goal: "A goal", briefMd: "" });

    const fresh = ok("save_campaign", { name: "Empty one", goal: "A goal" });
    expect(ok("undo_agent_action", { actionId: fresh.actionId }).reversed).toEqual(["removed the campaign and its group"]);
    expect(rows("SELECT name FROM groups ORDER BY id")).toEqual([{ name: "Short-lived" }]);

    const withPeople = ok("save_campaign", { name: "With people", goal: "A goal", addContactIds: [id.ben] });
    const undone = ok("undo_agent_action", { actionId: withPeople.actionId });
    expect(undone.reversed).toEqual(["removed 1 group member", "removed the campaign and its group"]);
    expect(rows("SELECT name FROM groups ORDER BY id")).toEqual([{ name: "Short-lived" }]);
  });

  it("writes the voice guide the drafts are written from, one version back kept for undo", () => {
    const guide = "Opens with the first name and a comma. Two short paragraphs, never more than 120 words. Mentions LBS in the first line. Closes with \"Best,\" and the first name.";
    expect(refused("update_voice_guide", { guide: "Be nice." })).toMatch(/guide/);
    const first = ok("update_voice_guide", { guide });
    expect(ok("get_voice_guide").guide).toBe(guide);
    const second = ok("update_voice_guide", { guide: `${guide} Never uses exclamation marks.` });
    expect(refused("undo_agent_action", { actionId: first.actionId })).toMatch(/changed since/);
    expect(ok("undo_agent_action", { actionId: second.actionId }).reversed).toEqual(["put the previous voice guide back"]);
    expect(ok("get_voice_guide").guide).toBe(guide);
    expect(refused("update_voice_guide", { guide }, ["read"])).toMatch(/read-only/);
  });

  it("in 'ask me first', a draft and a campaign wait for the owner", () => {
    const campaignId = campaign([id.ana]);
    ins("settings", { key: "agent.write_mode", value: JSON.stringify("review") });
    const draft = ok("save_draft", { contactId: id.ana, campaignId, kind: "first", subject: "Hello", body: "Dear Ana…" });
    const camp = ok("save_campaign", { name: "Proposed", goal: "A goal" });
    expect(draft.queued).toBe(true);
    expect(camp.queued).toBe(true);
    expect(rows("SELECT id FROM outreach_drafts")).toEqual([]);
    expect(rows("SELECT name FROM groups")).toEqual([{ name: "TMT banking" }]);
    expect(tools.approveQueuedCall(draft.actionId!)).toMatchObject({ ok: true });
    expect(rows("SELECT subject FROM outreach_drafts")).toEqual([{ subject: "Hello" }]);
  });

  it("Today tells the agent who is waiting and how many drafts are unsent", () => {
    const campaignId = campaign([id.ana, id.cara]);
    exchange(id.ana, "outbound", 20);
    exchange(id.ana, "outbound", 9);
    out.saveDraft({ contactId: id.cara, groupId: campaignId, kind: "first", subject: "Hello", body: "Dear Cara…", source: "agent" }, NOW);
    const data = ok("get_today");
    expect(data.draftsToSend).toBe(1);
    expect(data.awaitingReply).toMatchObject({ total: 1, items: [{ contactId: id.ana, name: "Ana Silva", campaign: "TMT banking", daysWaiting: 9, followUpsAlreadySent: 1 }] });
  });
});

describe("merging and deleting people", () => {
  it("a draft follows a merge and goes with a deleted contact", async () => {
    const { mergeContacts } = await import("@/lib/dedupe/merge");
    const groupId = campaign([id.cara]);
    out.saveDraft({ contactId: id.cara, groupId, kind: "first", subject: "Hello", body: "Dear Cara…", source: "agent" }, NOW);
    mergeContacts(rawDb, { winnerId: id.ana, loserId: id.cara, now: NOW });
    expect(rows("SELECT contact_id FROM outreach_drafts")).toEqual([{ contact_id: id.ana }]);
    rawDb.prepare("DELETE FROM contacts WHERE id = ?").run(id.ana);
    expect(rows("SELECT id FROM outreach_drafts")).toEqual([]);
  });
});
