import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// SPEC §17 and §9c career history, against a real database: firm tiers,
// address formats and guesses, bounces, the tools an agent reaches them
// through, and a profile's roles and schools landing once each.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireAuth: async () => {} }));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

let dataDir: string;
let rawDb: import("better-sqlite3").Database;
let firms: typeof import("@/server/firms-core");
let guess: typeof import("@/server/email-guess-core");
let out: typeof import("@/server/outreach-core");
let tools: typeof import("@/server/agent/tools");
const id: Record<string, number> = {};

function ins(table: string, row: Record<string, unknown>): number {
  const keys = Object.keys(row);
  return Number(rawDb.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row)).lastInsertRowid);
}
const rows = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => rawDb.prepare(sql).all(...p) as T[];
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => rawDb.prepare(sql).get(...p) as T;

function contact(name: string, company: string | null, email?: string, extra: Record<string, unknown> = {}): number {
  const [first, ...rest] = name.split(" ");
  const cid = ins("contacts", { first_name: first, last_name: rest.join(" ") || null, display_name: name, company, created_at: NOW - 200 * DAY, updated_at: NOW - 200 * DAY, ...extra });
  if (email) ins("contact_emails", { contact_id: cid, email, email_normalized: email.toLowerCase(), priority: 0, source: "google", created_at: NOW - 200 * DAY });
  return cid;
}
const emailsOf = (contactId: number) => rows<{ email: string; source: string }>("SELECT email, source FROM contact_emails WHERE contact_id = ? ORDER BY priority, id", contactId);

type Out = Record<string, unknown> & { error?: string; actionId?: number };
function call(name: string, args: unknown = {}, scopes = ["read", "write"]): { isError: boolean; data: Out; text: string } {
  const res = tools.callAgentTool(name, args, { grantId: null, scopes, now: NOW });
  return { isError: res.isError, data: JSON.parse(res.text) as Out, text: res.text };
}
function ok(name: string, args: unknown = {}): Out {
  const res = call(name, args);
  expect(res.isError, `${name} → ${res.text.slice(0, 400)}`).toBe(false);
  return res.data;
}
function refused(name: string, args: unknown = {}, scopes = ["read", "write"]): string {
  const res = call(name, args, scopes);
  expect(res.isError, `${name} → ${res.text.slice(0, 400)}`).toBe(true);
  return String(res.data.error);
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rolo-firms-"));
  process.env.ROLO_DATA_DIR = dataDir;
  const client = await import("@/db/client");
  rawDb = client.rawDb;
  migrate(client.db, { migrationsFolder: path.join(__dirname, "../../src/db/migrations") });
  firms = await import("@/server/firms-core");
  guess = await import("@/server/email-guess-core");
  out = await import("@/server/outreach-core");
  tools = await import("@/server/agent/tools");
});

beforeEach(() => {
  for (const t of ["agent_calls", "ai_suggestions", "contacts", "groups", "tags", "firms", "settings", "sync_runs"]) rawDb.prepare(`DELETE FROM ${t}`).run();
  ins("settings", { key: "timezone", value: JSON.stringify("Europe/London") });
  // Three people at Goldman whose addresses Rolo was given, and three it has none for.
  id.ana = contact("Ana Silva", "Goldman Sachs", "ana.silva@gs.test");
  id.ben = contact("Ben Okafor", "Goldman Sachs", "ben.okafor@gs.test");
  id.cara = contact("Cara Lin", "Goldman Sachs Ltd", "cara.lin@gs.test");
  id.dev = contact("Dev Patel", "Goldman Sachs");
  id.eve = contact("Eve Stone", "Goldman Sachs International");
  id.finn = contact("Finn Hale", "Lazard");
  id.gus = contact("Gus Ray", null);
});

afterAll(() => {
  rawDb?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("firms", () => {
  it("a firm is an employer of someone in Rolo, whatever the spelling", () => {
    expect(firms.setFirmTier({ company: "Nobody Works Here", tier: "Bulge bracket", source: "user" })).toMatchObject({ ok: false, error: expect.stringMatching(/Nobody in Rolo works at/) });
    expect(firms.setFirmTier({ company: "  ", tier: "x", source: "user" })).toMatchObject({ ok: false });
    expect(firms.setFirmTier({ company: "goldman sachs ltd", tier: "Bulge bracket", source: "user" }, NOW)).toMatchObject({ ok: true, created: true, changed: true, name: "Goldman Sachs" });
    expect(rows("SELECT company_key, name, tier, tier_source FROM firms")).toEqual([{ company_key: "goldman sachs", name: "Goldman Sachs", tier: "Bulge bracket", tier_source: "user" }]);
    expect(firms.listFirms()[0]).toMatchObject({ name: "Goldman Sachs", contacts: 4, tier: "Bulge bracket" });
    // Both spellings of the firm, and not its sister company.
    expect(firms.companySpellingsForTiers(["bulge BRACKET"]).sort()).toEqual(["Goldman Sachs", "Goldman Sachs Ltd"]);
    expect(firms.companySpellingsForTiers(["Elite boutique"])).toEqual([]);
  });

  it("tier names are reused whatever the case, and an emptied record is not kept", () => {
    firms.setFirmTier({ company: "Goldman Sachs", tier: "Bulge bracket", source: "user" }, NOW);
    expect(firms.setFirmTier({ company: "Lazard", tier: "bulge BRACKET", source: "user" }, NOW)).toMatchObject({ ok: true, after: { tier: "Bulge bracket" } });
    expect(firms.tierNames()).toEqual([{ tier: "Bulge bracket", firms: 2 }]);
    expect(firms.setFirmTier({ company: "Lazard", tier: null, source: "user" }, NOW)).toMatchObject({ ok: true, after: { tier: null } });
    expect(rows("SELECT name FROM firms")).toEqual([{ name: "Goldman Sachs" }]);
    expect(firms.setFirmTier({ company: "Lazard", tier: "x".repeat(60), source: "user" })).toMatchObject({ ok: true, after: { tier: `${"x".repeat(39)}…` } });
  });

  it("what the owner set, an agent cannot change; what an agent set, it can", () => {
    firms.setFirmTier({ company: "Goldman Sachs", tier: "Bulge bracket", source: "user" }, NOW);
    expect(firms.setFirmTier({ company: "Goldman Sachs", tier: "Mid-market", source: "agent" }, NOW)).toMatchObject({ ok: false, conflict: true, error: expect.stringMatching(/yourself, so it was kept/) });
    expect(firms.setFirmTier({ company: "Lazard", tier: "Mid-market", note: "a guess", source: "agent" }, NOW)).toMatchObject({ ok: true });
    expect(firms.setFirmTier({ company: "Lazard", tier: "Elite boutique", note: "league tables", source: "agent" }, NOW)).toMatchObject({ ok: true, changed: true });
    expect(firms.setFirmTier({ company: "Lazard", tier: "Bulge bracket", source: "user" }, NOW)).toMatchObject({ ok: true, after: { tier: "Bulge bracket", tierSource: "user", tierNote: null } });
    expect(rows("SELECT name, tier, tier_source FROM firms ORDER BY name")).toEqual([
      { name: "Goldman Sachs", tier: "Bulge bracket", tier_source: "user" },
      { name: "Lazard", tier: "Bulge bracket", tier_source: "user" },
    ]);
  });

  it("an address format needs a real firm domain and a known shape", () => {
    const set = (domain: string | null, pattern: unknown = "first.last") => firms.setFirmEmailFormat({ company: "Lazard", domain, pattern: pattern as never, source: "user" }, NOW);
    for (const bad of ["lazard", "lazard.com/x", "a@lazard.com&cc=x", "laz ard.com", "lazard.com?x=1"]) expect(set(bad), bad).toMatchObject({ ok: false, error: expect.stringMatching(/not a domain/) });
    for (const personal of ["gmail.com", "london.edu", "ox.ac.uk"]) expect(set(personal), personal).toMatchObject({ ok: false, error: expect.stringMatching(/mailbox provider or a school/) });
    expect(set("lazard.com", "whatever")).toMatchObject({ ok: false, error: expect.stringMatching(/how the part before the @/) });
    expect(set("@Lazard.com", "flast")).toMatchObject({ ok: true, after: { emailDomain: "lazard.com", emailPattern: "flast", emailSource: "user" } });
    expect(firms.setFirmEmailFormat({ company: "Lazard", domain: "lazard.co.uk", pattern: "first.last", basis: "published", note: "x", source: "agent" }, NOW)).toMatchObject({ ok: false, conflict: true });
    expect(set(null)).toMatchObject({ ok: true, after: { emailDomain: null } });
    expect(rows("SELECT name FROM firms")).toEqual([]);
  });
});

describe("working out an address", () => {
  it("learns the format from addresses Rolo was given, across spellings of the firm", () => {
    const s = guess.suggestionFor(id.dev)!;
    expect(s).toMatchObject({ emails: 0, reason: null });
    expect(s.candidates).toEqual([
      { email: "dev.patel@gs.test", domain: "gs.test", pattern: "first.last", strength: "strong", evidence: "3 of the 3 addresses Rolo holds at gs.test are built this way" },
    ]);
  });

  it("a firm that is part of a larger one borrows its evidence, and says whose it is", () => {
    // "Goldman Sachs Ltd" folds into "Goldman Sachs"; "Goldman Sachs International" is its own key.
    expect(guess.suggestionFor(id.eve)!.candidates[0]).toMatchObject({
      email: "eve.stone@gs.test",
      evidence: "3 of the 3 addresses Rolo holds at gs.test (from Goldman Sachs) are built this way",
    });
  });

  it("says why when there is nothing to go on", () => {
    expect(guess.suggestionFor(id.finn)).toMatchObject({ candidates: [], reason: "Rolo holds no address at Lazard to learn from, and no format has been recorded for it." });
    expect(guess.suggestionFor(id.gus)).toMatchObject({ candidates: [], reason: "Rolo does not know where this person works." });
    expect(guess.suggestionFor(424242)).toBeNull();
    expect(guess.suggestionsFor([]).size).toBe(0);
  });

  it("a format the owner recorded is enough by itself", () => {
    firms.setFirmEmailFormat({ company: "Lazard", domain: "lazard.test", pattern: "flast", source: "user" }, NOW);
    expect(guess.suggestionFor(id.finn)!.candidates).toEqual([
      { email: "fhale@lazard.test", domain: "lazard.test", pattern: "flast", strength: "strong", evidence: "the format you set for Lazard" },
    ]);
  });

  it("never offers an address somebody else in Rolo already holds", () => {
    const namesake = contact("Ana Silva", "Goldman Sachs");
    // ana.silva@gs.test is the other Ana's. Nothing else is known, so nothing is offered.
    expect(guess.suggestionFor(namesake)!.candidates).toEqual([]);
    expect(guess.suggestionFor(id.ana)).toMatchObject({ emails: 1, candidates: [] });
  });
});

describe("the owner's answer to a guess", () => {
  it("accepting puts it on the contact, marked — and only an address Rolo is suggesting", () => {
    expect(guess.acceptGuess(id.dev, "dev@evil.test", NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/no longer suggesting/) });
    expect(guess.acceptGuess(424242, "dev.patel@gs.test", NOW)).toMatchObject({ ok: false });
    expect(guess.acceptGuess(id.dev, "DEV.PATEL@gs.test", NOW)).toEqual({ ok: true, email: "dev.patel@gs.test" });
    expect(emailsOf(id.dev)).toEqual([{ email: "dev.patel@gs.test", source: "guess" }]);
    expect(rows("SELECT email_normalized, domain, pattern, status FROM email_guesses")).toEqual([{ email_normalized: "dev.patel@gs.test", domain: "gs.test", pattern: "first.last", status: "accepted" }]);
    expect([...guess.guessStates(id.dev)]).toEqual([["dev.patel@gs.test", "accepted"]]);
    // Twice is refused: it is no longer a suggestion.
    expect(guess.acceptGuess(id.dev, "dev.patel@gs.test", NOW)).toMatchObject({ ok: false });
    expect(emailsOf(id.dev)).toHaveLength(1);
  });

  it("an unproven guess is evidence of nothing; a confirmed one counts", () => {
    firms.setFirmEmailFormat({ company: "Lazard", domain: "lazard.test", pattern: "flast", source: "user" }, NOW);
    const hal = contact("Hal Moss", "Lazard");
    guess.acceptGuess(id.finn, "fhale@lazard.test", NOW);
    firms.setFirmEmailFormat({ company: "Lazard", domain: null, source: "user" }, NOW);
    // Finn's address was only ever a guess: with the format gone, Hal gets nothing.
    expect(guess.suggestionFor(hal)!.candidates).toEqual([]);
    expect(guess.confirmGuess(id.finn, "fhale@lazard.test", NOW)).toEqual({ ok: true, changed: true, wasGuess: true, previous: "accepted" });
    expect(guess.suggestionFor(hal)!.candidates[0]).toMatchObject({ email: "hmoss@lazard.test", strength: "weak", evidence: "1 of the 1 address Rolo holds at lazard.test is built this way" });
    expect(guess.confirmGuess(id.finn, "fhale@lazard.test", NOW)).toMatchObject({ changed: false, wasGuess: true });
    expect(guess.confirmGuess(id.ana, "ana.silva@gs.test", NOW)).toMatchObject({ ok: true, changed: false, wasGuess: false });
    expect(guess.confirmGuess(id.ana, "someone@else.test", NOW)).toMatchObject({ ok: false });
  });

  it("\"not this\" is remembered, and the next format moves up", () => {
    contact("Hal Moss", "Goldman Sachs", "hmoss@gs.test");
    expect(guess.suggestionFor(id.dev)!.candidates.map((c) => c.email)).toEqual(["dev.patel@gs.test", "dpatel@gs.test"]);
    expect(guess.dismissGuess(id.dev, "dev.patel@gs.test", NOW)).toEqual({ ok: true });
    expect(guess.suggestionFor(id.dev)!.candidates.map((c) => c.email)).toEqual(["dpatel@gs.test"]);
    expect(guess.dismissGuess(id.dev, "dev.patel@gs.test", NOW)).toMatchObject({ ok: false });
    // Dismissed for Dev only.
    expect(guess.suggestionFor(id.eve)!.candidates[0].email).toBe("eve.stone@gs.test");
  });
});

describe("a bounce", () => {
  function campaignWith(contactId: number): number {
    const res = out.saveCampaign({ name: "TMT banking", goal: "Coffee chats", startedAt: NOW - 30 * DAY }, NOW - 30 * DAY);
    if (!res.ok) throw new Error(res.error);
    ins("group_members", { group_id: res.groupId, contact_id: contactId, created_at: NOW });
    return res.groupId;
  }
  const sendTo = (contactId: number, daysAgo: number, title: string) =>
    ins("interactions", { contact_id: contactId, kind: "email", direction: "outbound", occurred_at: NOW - daysAgo * DAY, title, source: "user", source_key: `k${Math.random()}`, counts_for_touch: 1, created_at: NOW - daysAgo * DAY });
  const stageOf = (groupId: number, contactId: number) => out.campaignPipeline(groupId, NOW)!.members.find((m) => m.contactId === contactId)!;

  it("of a guess: the address goes, the email stops counting as sent, the next guess is offered", () => {
    contact("Hal Moss", "Goldman Sachs", "hmoss@gs.test");
    const groupId = campaignWith(id.dev);
    expect(stageOf(groupId, id.dev)).toMatchObject({ stage: "not_contacted", email: null, guess: { email: "dev.patel@gs.test" } });
    guess.acceptGuess(id.dev, "dev.patel@gs.test", NOW - 3 * DAY);
    rawDb.prepare("UPDATE contacts SET cadence_days = 30 WHERE id = ?").run(id.dev);
    const sent = sendTo(id.dev, 2, "LBS student — 15 minutes?");
    rawDb.prepare("UPDATE contacts SET last_interaction_at = ?, next_touch_at = ? WHERE id = ?").run(NOW - 2 * DAY, NOW + 28 * DAY, id.dev);
    expect(stageOf(groupId, id.dev)).toMatchObject({ stage: "awaiting_reply", email: "dev.patel@gs.test", guess: null });

    const res = guess.recordBounce({ contactId: id.dev, email: "Dev.Patel@gs.test", subject: "Undeliverable: LBS student — 15 minutes?" }, NOW);
    // "Undeliverable:" is not a reply prefix: with a subject that does not match, the timeline is left alone.
    expect(res).toMatchObject({ ok: true, record: { retracted: { email: "dev.patel@gs.test", source: "guess" }, tagged: null, send: null } });
    guess.undoBounce((res as { record: import("@/server/email-guess-core").BounceRecord }).record, NOW);
    expect(emailsOf(id.dev)).toEqual([{ email: "dev.patel@gs.test", source: "guess" }]);

    const again = guess.recordBounce({ contactId: id.dev, email: "dev.patel@gs.test", subject: "RE: LBS student — 15 minutes?" }, NOW);
    if (!again.ok) throw new Error(again.error);
    expect(again.record).toMatchObject({ retracted: { email: "dev.patel@gs.test" }, tagged: null, send: { id: sent, countedForTouch: true } });
    expect(again.sendTitle).toBe("LBS student — 15 minutes?");
    expect(again.next.map((c) => c.email)).toEqual(["dpatel@gs.test"]);
    expect(emailsOf(id.dev)).toEqual([]);
    expect(one("SELECT status FROM email_guesses WHERE contact_id = ?", id.dev)).toEqual({ status: "bounced" });
    expect(one("SELECT meta, counts_for_touch AS touch FROM interactions WHERE id = ?", sent)).toEqual({ meta: '{"bounced":true,"bouncedAddress":"dev.patel@gs.test"}', touch: 0 });
    // Nobody is waiting on a reply to an email that never arrived, and the keep-in-touch clock forgets it.
    expect(stageOf(groupId, id.dev)).toMatchObject({ stage: "not_contacted", email: null, guess: { email: "dpatel@gs.test" } });
    expect(one("SELECT last_interaction_at AS last FROM contacts WHERE id = ?", id.dev)).toEqual({ last: null });
    expect(rows("SELECT name FROM tags")).toEqual([]);

    // The format bounced for Dev. Three real addresses still back it, so for Eve it stays first — a notch less sure, and saying why.
    const eve = guess.suggestionFor(id.eve)!.candidates;
    expect(eve.map((c) => [c.email, c.strength])).toEqual([["eve.stone@gs.test", "fair"], ["estone@gs.test", "weak"]]);
    expect(eve[0].evidence).toBe("3 of the 4 addresses Rolo holds at gs.test (from Goldman Sachs) are built this way; but it bounced for 1 other person there");

    // Undo: everything as it was.
    const undone = guess.undoBounce(again.record, NOW);
    expect(undone).toEqual({ reversed: ["put the address back on the contact", "counted the email as sent again"], skipped: [] });
    expect(emailsOf(id.dev)).toEqual([{ email: "dev.patel@gs.test", source: "guess" }]);
    expect(one("SELECT status FROM email_guesses WHERE contact_id = ?", id.dev)).toEqual({ status: "accepted" });
    expect(one("SELECT meta, counts_for_touch AS touch FROM interactions WHERE id = ?", sent)).toEqual({ meta: null, touch: 1 });
    expect(stageOf(groupId, id.dev).stage).toBe("awaiting_reply");
    expect(one("SELECT last_interaction_at AS last FROM contacts WHERE id = ?", id.dev)).toEqual({ last: NOW - 2 * DAY });
  });

  it("of an address Rolo was given: it stays, the contact is tagged, the email stops counting", () => {
    const groupId = campaignWith(id.ana);
    sendTo(id.ana, 40, "An old email");
    const sent = sendTo(id.ana, 1, "LBS student — 15 minutes?");
    const res = guess.recordBounce({ contactId: id.ana, email: "ana.silva@gs.test" }, NOW);
    if (!res.ok) throw new Error(res.error);
    expect(res.record).toMatchObject({ retracted: null, tagged: { tagName: "bad address", createdTag: true }, send: { id: sent } });
    expect(emailsOf(id.ana)).toEqual([{ email: "ana.silva@gs.test", source: "google" }]);
    expect(stageOf(groupId, id.ana).stage).toBe("bad_address");
    // The same bounce again changes nothing more; the 40-day-old email is out of reach.
    const twice = guess.recordBounce({ contactId: id.ana, email: "ana.silva@gs.test" }, NOW);
    expect(twice).toMatchObject({ ok: true, record: { retracted: null, tagged: null, send: null } });
    expect(rows("SELECT count(*) AS n FROM interactions WHERE meta LIKE '%bounced%'")).toEqual([{ n: 1 }]);
    expect(guess.undoBounce(res.record, NOW).reversed).toEqual(['removed the tag "bad address"', "counted the email as sent again"]);
    expect(stageOf(groupId, id.ana).stage).toBe("awaiting_reply");
  });

  it("is refused for an address that was never this person's, and leaves a changed email alone on undo", () => {
    expect(guess.recordBounce({ contactId: id.ana, email: "someone@else.test" }, NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/not one Rolo holds/) });
    expect(guess.recordBounce({ contactId: id.ana, email: "not an address" }, NOW)).toMatchObject({ ok: false });
    expect(guess.recordBounce({ contactId: 424242, email: "ana.silva@gs.test" }, NOW)).toMatchObject({ ok: false });
    const sent = sendTo(id.ana, 1, "Hello");
    const res = guess.recordBounce({ contactId: id.ana, email: "ana.silva@gs.test" }, NOW);
    if (!res.ok) throw new Error(res.error);
    // The row is deleted and its id reused by an unrelated email: undo must not touch it.
    rawDb.prepare("DELETE FROM interactions WHERE id = ?").run(sent);
    const reused = ins("interactions", { id: sent, contact_id: id.ben, kind: "email", direction: "outbound", occurred_at: NOW, title: "Unrelated", source: "user", counts_for_touch: 1, meta: '{"bounced":true}', created_at: NOW });
    expect(guess.undoBounce(res.record, NOW).skipped).toContain("the email it marked has changed since, so it was left");
    expect(one("SELECT meta FROM interactions WHERE id = ?", reused)).toEqual({ meta: '{"bounced":true}' });
  });
});

describe("drafts and addresses", () => {
  it("a draft goes to the primary address, not the last one listed", () => {
    ins("contact_emails", { contact_id: id.ana, email: "ana@personal.test", email_normalized: "ana@personal.test", priority: 1, source: "user", created_at: NOW });
    const d = out.saveDraft({ contactId: id.ana, groupId: null, kind: "first", subject: "Hello", body: "Dear Ana…", source: "agent" }, NOW);
    expect(d).toMatchObject({ ok: true, draft: { toEmail: "ana.silva@gs.test" } });
  });

  it("a draft written before the address was known picks it up; one to a bounced guess lets go of it", () => {
    contact("Hal Moss", "Goldman Sachs", "hmoss@gs.test");
    const d = out.saveDraft({ contactId: id.dev, groupId: null, kind: "first", subject: "Hello", body: "Dear Dev…", source: "agent" }, NOW);
    expect(d).toMatchObject({ ok: true, draft: { toEmail: null } });
    expect(out.listDrafts()[0].toEmail).toBeNull();
    guess.acceptGuess(id.dev, "dev.patel@gs.test", NOW);
    expect(out.listDrafts()[0].toEmail).toBe("dev.patel@gs.test");
    guess.recordBounce({ contactId: id.dev, email: "dev.patel@gs.test" }, NOW);
    expect(out.listDrafts()[0].toEmail).toBeNull();
    guess.acceptGuess(id.dev, "dpatel@gs.test", NOW);
    expect(out.listDrafts()[0].toEmail).toBe("dpatel@gs.test");
  });
});

describe("what Claude can do with it", () => {
  it("suggest_emails gives guesses with evidence — and no way to use one", () => {
    const res = ok("suggest_emails", { contactIds: [id.dev, id.finn, id.ana, 424242] });
    expect(res.unknownContactIds).toEqual([424242]);
    expect(res.people).toEqual([
      { contactId: id.dev, name: "Dev Patel", company: "Goldman Sachs", addressesAlreadyInRolo: 0, guesses: [{ email: "dev.patel@gs.test", strength: "strong", evidence: "3 of the 3 addresses Rolo holds at gs.test are built this way" }] },
      { contactId: id.finn, name: "Finn Hale", company: "Lazard", addressesAlreadyInRolo: 0, guesses: [], nothingToSuggest: "Rolo holds no address at Lazard to learn from, and no format has been recorded for it." },
      { contactId: id.ana, name: "Ana Silva", company: "Goldman Sachs", addressesAlreadyInRolo: 1, guesses: [], nothingToSuggest: "Rolo already holds the address its formats give for this person." },
    ]);
    expect(String(res.note)).toMatch(/Only the owner can accept one/);
    expect(emailsOf(id.dev)).toEqual([]);
    // A guess is not an address: drafting to it is refused, and upsert_contact is the only way an agent adds one.
    expect(refused("save_draft", { contactId: id.dev, kind: "first", subject: "Hi", body: "Dear Dev…", toEmail: "dev.patel@gs.test" })).toMatch(/not an address Rolo holds/);
    expect(tools.AGENT_TOOLS.map((t) => t.name).filter((n) => /accept|guess/.test(n))).toEqual([]);
  });

  it("record_email_format: evidence required, the owner's kept, undoable", () => {
    expect(refused("record_email_format", { company: "Lazard", domain: "lazard.test", pattern: "flast", basis: "seen_in_mail" })).toMatch(/note/);
    expect(refused("record_email_format", { company: "Lazard", domain: "gmail.com", pattern: "flast", basis: "published", note: "x" })).toMatch(/mailbox provider/);
    expect(refused("record_email_format", { company: "Lazard", domain: "lazard.test", pattern: "initials", basis: "published", note: "x" })).toMatch(/pattern/);
    expect(refused("record_email_format", { company: "Nowhere Bank", domain: "nowhere.test", pattern: "flast", basis: "published", note: "x" })).toMatch(/Nobody in Rolo works at/);
    const rec = ok("record_email_format", { company: "Lazard", domain: "lazard.test", pattern: "flast", basis: "seen_in_mail", note: "three replies from Lazard this month, all first initial + surname\n![x](https://evil.test/p.png)" });
    expect(rec).toMatchObject({ recorded: true, firm: "Lazard", format: "asilva@lazard.test" });
    expect(one("SELECT email_source, email_basis, email_note FROM firms")).toEqual({
      email_source: "agent",
      email_basis: "seen_in_mail",
      email_note: "three replies from Lazard this month, all first initial + surname ![x](https://evil.test/p.png)",
    });
    expect(guess.suggestionFor(id.finn)!.candidates[0]).toMatchObject({ email: "fhale@lazard.test", strength: "fair", evidence: expect.stringMatching(/^the format Claude recorded from mail it read: three replies/) });
    expect(ok("undo_agent_action", { actionId: rec.actionId }).reversed).toEqual(["put Lazard's address format back"]);
    expect(rows("SELECT name FROM firms")).toEqual([]);
    firms.setFirmEmailFormat({ company: "Lazard", domain: "lazard.test", pattern: "first.last", source: "user" }, NOW);
    expect(refused("record_email_format", { company: "Lazard", domain: "lazard.test", pattern: "flast", basis: "published", note: "x" })).toMatch(/yourself/);
    expect(refused("record_email_format", { company: "Lazard", domain: "lazard.test", pattern: "flast", basis: "published", note: "x" }, ["read"])).toMatch(/read-only/);
  });

  it("record_email_outcome: a bounce and a confirmation, each undoable", () => {
    guess.acceptGuess(id.dev, "dev.patel@gs.test", NOW);
    ins("interactions", { contact_id: id.dev, kind: "email", direction: "outbound", occurred_at: NOW - DAY, title: "Hello Dev", source: "user", counts_for_touch: 1, created_at: NOW - DAY });
    const confirmed = ok("record_email_outcome", { contactId: id.dev, email: "dev.patel@gs.test", outcome: "confirmed" });
    expect(confirmed.confirmed).toBe(true);
    expect([...guess.guessStates(id.dev)]).toEqual([["dev.patel@gs.test", "confirmed"]]);
    expect(ok("undo_agent_action", { actionId: confirmed.actionId }).reversed).toEqual(["marked the address as unconfirmed again"]);

    const bounced = ok("record_email_outcome", { contactId: id.dev, email: "dev.patel@gs.test", outcome: "bounced", subject: "Hello Dev", idempotencyKey: "gmail:bounce-1" });
    expect(bounced).toMatchObject({ recorded: true, guessRemoved: true, taggedBadAddress: false, emailNoLongerCountsAsSent: "Hello Dev" });
    expect(emailsOf(id.dev)).toEqual([]);
    expect(ok("record_email_outcome", { contactId: id.dev, email: "dev.patel@gs.test", outcome: "bounced", subject: "Hello Dev", idempotencyKey: "gmail:bounce-1" })).toMatchObject({ alreadyDone: true });
    expect(ok("undo_agent_action", { actionId: bounced.actionId }).reversed).toEqual(["put the address back on the contact", "counted the email as sent again"]);
    expect(emailsOf(id.dev)).toEqual([{ email: "dev.patel@gs.test", source: "guess" }]);
    expect(refused("record_email_outcome", { contactId: id.dev, email: "x@y.test", outcome: "bounced" })).toMatch(/not one Rolo holds/);
    expect(refused("record_email_outcome", { contactId: id.dev, email: "dev.patel@gs.test", outcome: "out_of_office" })).toMatch(/outcome/);
  });

  it("propose_firm_tiers always waits for the owner — even when other writes apply at once", () => {
    firms.setFirmTier({ company: "Lazard", tier: "Elite boutique", source: "user" }, NOW);
    expect(refused("propose_firm_tiers", { firms: [{ company: "Nowhere Bank", tier: "Bulge bracket", why: "x" }] })).toMatch(/Nobody in Rolo works at/);
    expect(refused("propose_firm_tiers", { firms: Array.from({ length: 7 }, (_, i) => ({ company: "Goldman Sachs", tier: `Tier ${i}`, why: "x" })) })).toMatch(/At most 6 different tiers/);
    expect(rows("SELECT count(*) AS n FROM agent_calls WHERE status = 'queued'")).toEqual([{ n: 0 }]);

    const proposal = ok("propose_firm_tiers", {
      firms: [
        { company: "Goldman Sachs", tier: "Bulge bracket", why: "global full-service bank" },
        { company: "Goldman Sachs International", tier: "bulge bracket", why: "the same bank's UK entity" },
        { company: "Lazard", tier: "Mid-market", why: "wrong, and the owner said otherwise" },
      ],
    });
    expect(proposal).toMatchObject({ queued: true, note: expect.stringMatching(/always waits for the owner/) });
    expect(rows("SELECT name, tier FROM firms")).toEqual([{ name: "Lazard", tier: "Elite boutique" }]);

    expect(tools.approveQueuedCall(proposal.actionId!)).toMatchObject({ ok: true });
    expect(rows("SELECT name, tier, tier_source, tier_note FROM firms ORDER BY name")).toEqual([
      { name: "Goldman Sachs", tier: "Bulge bracket", tier_source: "agent", tier_note: "global full-service bank" },
      { name: "Goldman Sachs International", tier: "Bulge bracket", tier_source: "agent", tier_note: "the same bank's UK entity" },
      { name: "Lazard", tier: "Elite boutique", tier_source: "user", tier_note: null },
    ]);
    // The owner moves one; undo takes back only what is still the proposal's.
    firms.setFirmTier({ company: "Goldman Sachs International", tier: "Elite boutique", source: "user" }, NOW);
    // What the owner approved, an agent does not take back by itself: the undo waits for them too.
    const undo = ok("undo_agent_action", { actionId: proposal.actionId });
    expect(undo).toMatchObject({ queued: true, note: expect.stringMatching(/always waits for the owner/) });
    expect(one("SELECT tier FROM firms WHERE name = 'Goldman Sachs'")).toEqual({ tier: "Bulge bracket" });
    expect(tools.approveQueuedCall(undo.actionId!)).toMatchObject({ ok: true });
    expect(one<{ summary: string }>("SELECT summary FROM agent_calls WHERE id = ?", undo.actionId).summary).toMatch(/Undid/i);
    expect(rows("SELECT name, tier FROM firms ORDER BY name")).toEqual([
      { name: "Goldman Sachs International", tier: "Elite boutique" },
      { name: "Lazard", tier: "Elite boutique" },
    ]);
  });

  it("suggest_tags waits in the review queue with its evidence; nothing is tagged until approved", async () => {
    const tmt = ins("tags", { name: "TMT", color: "#888", created_at: NOW });
    ins("contact_tags", { contact_id: id.ben, tag_id: tmt, created_at: NOW });
    expect(refused("suggest_tags", { suggestions: [{ contactId: id.ana, tag: "TMT", evidence: "x" }] })).toMatch(/evidence/);
    const res = ok("suggest_tags", {
      suggestions: [
        { contactId: id.ana, tag: "tmt", evidence: "Role description: \"covering software and internet clients\"" },
        { contactId: id.ana, tag: "TMT", evidence: "the same thing again, said twice" },
        { contactId: id.ben, tag: "TMT", evidence: "already tagged, so this is skipped" },
        { contactId: id.cara, tag: "Healthcare [x](http://evil.test)", evidence: "Deal announcement, March 2026: advised on a biotech IPO" },
        { contactId: 424242, tag: "TMT", evidence: "nobody has this id in Rolo" },
      ],
    });
    expect(res.suggested).toBe(2);
    expect(res.leftOut).toEqual([
      { contactId: id.ana, tag: "TMT", why: "already waiting for the owner" },
      { contactId: id.ben, tag: "TMT", why: "already has this tag" },
      { contactId: 424242, tag: "TMT", why: "no such contact" },
    ]);
    expect(rows("SELECT contact_id FROM contact_tags ORDER BY contact_id")).toEqual([{ contact_id: id.ben }]);

    const ai = await import("@/server/ai");
    const queue = await ai.readSuggestions();
    expect(queue.map((s) => [s.contactName, s.tagName, s.isNewTag, s.fromAgent, s.rationale]).sort()).toEqual([
      ["Ana Silva", "TMT", false, true, 'Role description: "covering software and internet clients"'],
      ["Cara Lin", "Healthcare (x)(http://evil.test)", true, true, "Deal announcement, March 2026: advised on a biotech IPO"],
    ]);
    await ai.resolveSuggestionsAction({ ids: [queue.find((s) => s.contactName === "Ana Silva")!.id], approve: true });
    expect(rows("SELECT contact_id FROM contact_tags ORDER BY contact_id")).toEqual([{ contact_id: id.ana }, { contact_id: id.ben }]);
    // Undo withdraws what the owner has not answered, and leaves what they approved.
    const undone = ok("undo_agent_action", { actionId: res.actionId });
    expect(undone.reversed).toEqual(["withdrew 1 tag suggestion"]);
    expect(undone.leftInPlace).toEqual(["1 tag suggestion was already answered"]);
    expect(rows("SELECT status FROM ai_suggestions")).toEqual([{ status: "approved" }]);
    expect(rows("SELECT contact_id FROM contact_tags ORDER BY contact_id")).toEqual([{ contact_id: id.ana }, { contact_id: id.ben }]);
  });

  it("tiers, schools and role text are searchable; profiles and pipelines carry them", () => {
    firms.setFirmTier({ company: "Goldman Sachs", tier: "Bulge bracket", source: "user" }, NOW);
    firms.setFirmEmailFormat({ company: "Goldman Sachs", domain: "gs.test", pattern: "first.last", source: "user" }, NOW);
    ins("work_history", { contact_id: id.ana, company: "Goldman Sachs", company_normalized: "goldman sachs", title: "Vice President", start_date: "2022-01", is_current: 1, description: "TMT: covering software and internet clients across EMEA.", source: "linkedin_profile", created_at: NOW });
    ins("education", { contact_id: id.finn, school: "London Business School", degree: "MBA", field: "Finance", end_year: 2025, source: "linkedin_profile", created_at: NOW });
    const names = (args: unknown) => (ok("search_contacts", args).contacts as { name: string }[]).map((c) => c.name).sort();
    expect(names({ firmTiers: ["bulge bracket"] })).toEqual(["Ana Silva", "Ben Okafor", "Cara Lin", "Dev Patel"]);
    expect(names({ firmTiers: ["Elite boutique"] })).toEqual([]);
    expect(names({ careerContains: "software" })).toEqual(["Ana Silva"]);
    expect(names({ careerContains: "100%_x" })).toEqual([]);
    expect(names({ education: "london business" })).toEqual(["Finn Hale"]);
    expect(names({ firmTiers: ["Bulge bracket"], careerContains: "TMT", query: "ana" })).toEqual(["Ana Silva"]);

    const companies = ok("list_companies", {});
    expect(companies.tiers).toEqual([{ tier: "Bulge bracket", firms: 1 }]);
    expect((companies.companies as Record<string, unknown>[]).find((c) => c.company === "Goldman Sachs")).toMatchObject({ contacts: 4, tier: "Bulge bracket", emailFormat: "ana.silva@gs.test" });
    expect((ok("list_companies", { tier: "none" }).companies as { company: string }[]).map((c) => c.company).sort()).toEqual(["Goldman Sachs International", "Lazard"]);
    expect((ok("list_companies", { tier: "bulge bracket" }).companies as { company: string }[]).map((c) => c.company)).toEqual(["Goldman Sachs"]);

    guess.acceptGuess(id.dev, "dev.patel@gs.test", NOW);
    const [ana, dev] = ok("get_contacts", { ids: [id.ana, id.dev] }).contacts as Record<string, unknown>[];
    expect(ana).toMatchObject({ firmTier: "Bulge bracket", workHistory: [{ title: "Vice President", description: "TMT: covering software and internet clients across EMEA." }] });
    expect(dev.emails).toEqual([{ email: "dev.patel@gs.test", label: null, unconfirmedGuess: true }]);

    const made = out.saveCampaign({ name: "TMT banking", goal: "Coffee chats" }, NOW);
    if (!made.ok) throw new Error(made.error);
    const hal = contact("Hal Moss", "Goldman Sachs");
    for (const c of [id.ana, hal]) ins("group_members", { group_id: made.groupId, contact_id: c, created_at: NOW });
    expect(ok("get_pipeline", { campaignId: made.groupId }).people).toEqual([
      { contactId: id.ana, name: "Ana Silva", title: null, company: "Goldman Sachs", hasEmail: true, firmTier: "Bulge bracket", stage: "not_contacted" },
      { contactId: hal, name: "Hal Moss", title: null, company: "Goldman Sachs", hasEmail: false, firmTier: "Bulge bracket", emailGuessAvailable: true, stage: "not_contacted" },
    ]);
  });
});

describe("a profile's career, captured", () => {
  const TOKEN = "e2e-extension-token-0123456789";
  const twice = (...lines: string[]) => lines.flatMap((l) => [l, l]);
  const sections = {
    experience: [
      {
        lines: twice("Vice President", "Goldman Sachs · Full-time", "Jan 2022 - Present · 2 yrs 11 mos", "London, England, United Kingdom · Hybrid"),
        children: [{ lines: twice("TMT investment banking: covering software and internet clients.") }, { lines: twice("Skills: M&A · Valuation") }],
      },
      {
        lines: twice("Morgan Stanley", "Full-time · 4 yrs"),
        children: [{ lines: twice("Associate", "Jan 2020 - Dec 2021 · 2 yrs") }, { lines: twice("Analyst", "Jan 2018 - Dec 2019 · 2 yrs", "Healthcare coverage.") }],
      },
      { lines: ["Show all 9 experiences"] },
    ],
    education: [{ lines: twice("London Business School", "Master of Business Administration - MBA, Finance", "2016 - 2018") }],
    about: "About\nI cover software.\n…see more",
  };
  async function capture(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const route = await import("@/app/api/linkedin/extension/capture/route");
    const res = await route.POST(
      new NextRequest("http://localhost/api/linkedin/extension/capture", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }
  const profile = { publicIdentifier: "ana-silva-1", firstName: "Ana", lastName: "Silva", headline: "Tech M&A at Goldman Sachs", location: "London" };
  const history = () => rows("SELECT company, title, start_date, end_date, is_current, description, source FROM work_history ORDER BY is_current DESC, start_date DESC");

  beforeEach(() => {
    ins("settings", { key: "linkedin_extension.token", value: JSON.stringify(TOKEN) });
    rawDb.prepare("DELETE FROM contacts").run();
  });

  it("adds a new person with their roles, schools and bio — and a second capture changes nothing", async () => {
    const first = await capture({ profile, sections });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ ok: true, created: true, career: { read: { roles: 3, schools: 1, about: true }, rolesAdded: 2, rolesUpdated: 1, schoolsAdded: 1, bio: "set" } });
    expect(history()).toEqual([
      // The row the import keeps from the headline became the real role: one row, not two.
      { company: "Goldman Sachs", title: "Vice President", start_date: "2022-01", end_date: null, is_current: 1, description: "TMT investment banking: covering software and internet clients.", source: "linkedin_profile" },
      { company: "Morgan Stanley", title: "Associate", start_date: "2020-01", end_date: "2021-12", is_current: 0, description: null, source: "linkedin_profile" },
      { company: "Morgan Stanley", title: "Analyst", start_date: "2018-01", end_date: "2019-12", is_current: 0, description: "Healthcare coverage.", source: "linkedin_profile" },
    ]);
    expect(rows("SELECT school, degree, field, start_year, end_year FROM education")).toEqual([
      { school: "London Business School", degree: "Master of Business Administration - MBA", field: "Finance", start_year: 2016, end_year: 2018 },
    ]);
    expect(one("SELECT bio, title, company FROM contacts")).toEqual({ bio: "I cover software.", title: "Tech M&A", company: "Goldman Sachs" });

    const second = await capture({ profile, sections });
    expect(second.json).toMatchObject({ ok: true, created: false, career: { rolesAdded: 0, rolesUpdated: 0, schoolsAdded: 0, schoolsUpdated: 0, bio: "unchanged" } });
    expect(history()).toHaveLength(3);
    expect(rows("SELECT id FROM education")).toHaveLength(1);
    // The same headline arriving again through any LinkedIn import neither duplicates the role nor rewrites its title.
    const third = await capture({ profile });
    expect(third.json).toMatchObject({ ok: true });
    expect(third.json.career).toBeUndefined();
    expect(history()).toHaveLength(3);
    expect(history()[0]).toMatchObject({ title: "Vice President", source: "linkedin_profile" });
  });

  it("keeps a bio the owner wrote, and reads a details page that has no name on it", async () => {
    await capture({ profile });
    const contactId = one<{ id: number }>("SELECT id FROM contacts").id;
    rawDb.prepare("UPDATE contacts SET bio = 'Met at the LBS tech trek.' WHERE id = ?").run(contactId);
    ins("contact_field_sources", { contact_id: contactId, field: "bio", source: "user", updated_at: NOW });
    const res = await capture({ profile: { publicIdentifier: "Ana-Silva-1" }, sections });
    expect(res.json).toMatchObject({ ok: true, contactId, career: { rolesAdded: 2, rolesUpdated: 1, bio: "kept" } });
    expect(one("SELECT bio FROM contacts")).toEqual({ bio: "Met at the LBS tech trek." });
    // The same page for somebody who is not in Rolo cannot create a nameless contact.
    expect((await capture({ profile: { publicIdentifier: "nobody-here" }, sections })).status).toBe(422);
    expect(rows("SELECT id FROM contacts")).toHaveLength(1);
  });

  it("a change of employer after a capture still ends the old job and starts the new one", async () => {
    await capture({ profile, sections });
    const moved = await capture({ profile: { ...profile, headline: "Director at Morgan Stanley" } });
    expect(moved.json).toMatchObject({ ok: true });
    const month = new Date().toISOString().slice(0, 7);
    expect(history().filter((r) => (r as { is_current: number }).is_current === 1)).toEqual([
      { company: "Morgan Stanley", title: "Director", start_date: month, end_date: null, is_current: 1, description: null, source: "linkedin" },
    ]);
    expect(history().find((r) => (r as { company: string }).company === "Goldman Sachs")).toMatchObject({ title: "Vice President", start_date: "2022-01", end_date: month, is_current: 0, source: "linkedin_profile" });
    const contactId = one<{ id: number }>("SELECT id FROM contacts").id;
    const names = (mode: string) => (ok("search_contacts", { company: "Goldman Sachs", companyMode: mode }).contacts as { id: number }[]).map((c) => c.id);
    expect(names("ex")).toEqual([contactId]);
    expect(names("current")).toEqual([]);
  });

  it("a profile that spells the employer in full does not leave two current rows for one job", async () => {
    const full = { ...sections, experience: [{ lines: twice("Vice President", "Goldman Sachs International · Full-time", "Jan 2022 - Present · 2 yrs 11 mos") }] };
    await capture({ profile, sections: full });
    expect(history()).toEqual([
      { company: "Goldman Sachs", title: "Vice President", start_date: "2022-01", end_date: null, is_current: 1, description: null, source: "linkedin_profile" },
    ]);
    await capture({ profile });
    expect(history()).toHaveLength(1);
  });

  it("a \"show all experiences\" page never names, renames or creates anyone", async () => {
    await capture({ profile });
    const details = { ...sections, page: "details" };
    const res = await capture({ profile: { publicIdentifier: "ana-silva-1", fullName: "Experience | Ana Silva" }, sections: details });
    expect(res.json).toMatchObject({ ok: true, updated: false, career: { rolesAdded: 2, rolesUpdated: 1 } });
    expect(one("SELECT first_name, last_name FROM contacts")).toEqual({ first_name: "Ana", last_name: "Silva" });
    const stranger = await capture({ profile: { publicIdentifier: "bo-li-9", fullName: "Experience | Bo Li" }, sections: details });
    expect(stranger.status).toBe(422);
    expect(stranger.json.error).toMatch(/main profile page first/);
    expect(rows("SELECT id FROM contacts")).toHaveLength(1);
  });

  it("refuses sections it cannot read, a missing token, and reports a page that gave nothing", async () => {
    expect((await capture({ profile, sections: { experience: "lots" } })).status).toBe(400);
    expect(rows("SELECT id FROM contacts")).toHaveLength(0);
    const route = await import("@/app/api/linkedin/extension/capture/route");
    const noToken = await route.POST(new NextRequest("http://localhost/api/linkedin/extension/capture", { method: "POST", body: JSON.stringify({ profile, sections }) }));
    expect(noToken.status).toBe(401);
    const empty = await capture({ profile, sections: { experience: [], education: [], about: null } });
    expect(empty.json).toMatchObject({ ok: true, career: { read: { roles: 0, schools: 0, about: false }, rolesAdded: 0, bio: "none" } });
  });
});

// Each of these was found by an independent review of the first version
// and proved with a failing test before it was fixed.
describe("found by the review", () => {
  const sendTo = (contactId: number, daysAgo: number, title: string, extra: Record<string, unknown> = {}) =>
    ins("interactions", { contact_id: contactId, kind: "email", direction: "outbound", occurred_at: NOW - daysAgo * DAY, title, source: "user", source_key: `k${Math.random()}`, counts_for_touch: 1, created_at: NOW - daysAgo * DAY, ...extra });
  const marked = () => rows<{ title: string }>("SELECT title FROM interactions WHERE meta LIKE '%bounced%' ORDER BY id").map((r) => r.title);

  it("an agent cannot put Rolo's own guess on a contact by the ordinary door — current, turned down or bounced", () => {
    expect(refused("upsert_contact", { contactId: id.dev, emails: ["Dev.Patel@gs.test"] })).toMatch(/Rolo's own guess for this person.*Only the owner can accept it/);
    expect(emailsOf(id.dev)).toEqual([]);
    contact("Hal Moss", "Goldman Sachs", "hmoss@gs.test");
    guess.dismissGuess(id.dev, "dev.patel@gs.test", NOW);
    expect(refused("upsert_contact", { contactId: id.dev, emails: ["dev.patel@gs.test"] })).toMatch(/turned .* down as a guess/);
    guess.acceptGuess(id.dev, "dpatel@gs.test", NOW);
    guess.recordBounce({ contactId: id.dev, email: "dpatel@gs.test" }, NOW);
    expect(refused("upsert_contact", { contactId: id.dev, emails: ["dpatel@gs.test"] })).toMatch(/bounced when it was tried/);
    // …for a second record of the same person, too.
    const twin = contact("Dev Patel", "Goldman Sachs");
    expect(refused("upsert_contact", { contactId: twin, emails: ["dpatel@gs.test"] })).toMatch(/bounced/);
    // The bounced address is dead for the twin as well; the one merely turned down for Dev is still theirs to consider.
    expect(guess.suggestionFor(twin)!.candidates.map((c) => c.email)).toEqual(["dev.patel@gs.test"]);
    expect(rows("SELECT count(*) AS n FROM contact_emails WHERE contact_id IN (?, ?)", id.dev, twin)).toEqual([{ n: 0 }]);
    // An address that is nobody's guess is still an agent's to add, attributed as its own.
    expect(ok("upsert_contact", { contactId: id.finn, emails: ["finn@hale-family.test"] })).toMatchObject({ updated: true });
    expect(emailsOf(id.finn)).toEqual([{ email: "finn@hale-family.test", source: "agent" }]);
    // One person's address at a domain that is not the firm's says nothing about the firm.
    expect(guess.suggestionFor(contact("Hal Moss", "Lazard"))!.candidates).toEqual([]);
  });

  it("the same bounce reported twice marks one email, not the one before it as well", () => {
    sendTo(id.ana, 6, "First email");
    sendTo(id.ana, 1, "Follow-up");
    expect(ok("record_email_outcome", { contactId: id.ana, email: "ana.silva@gs.test", outcome: "bounced", idempotencyKey: "gmail:m1" })).toMatchObject({ emailNoLongerCountsAsSent: "Follow-up" });
    const again = ok("record_email_outcome", { contactId: id.ana, email: "ana.silva@gs.test", outcome: "bounced", idempotencyKey: "gmail:m2" });
    expect(again).toMatchObject({ recorded: false, emailNoLongerCountsAsSent: null, note: expect.stringMatching(/already recorded/) });
    expect(marked()).toEqual(["Follow-up"]);
    // A guess that already went: nothing at all.
    contact("Hal Moss", "Goldman Sachs", "hmoss@gs.test");
    guess.acceptGuess(id.dev, "dev.patel@gs.test", NOW);
    sendTo(id.dev, 5, "Older");
    sendTo(id.dev, 1, "Newer");
    guess.recordBounce({ contactId: id.dev, email: "dev.patel@gs.test" }, NOW);
    expect(guess.recordBounce({ contactId: id.dev, email: "dev.patel@gs.test" }, NOW)).toMatchObject({ ok: true, noSend: "already_recorded", record: { retracted: null, send: null } });
    expect(marked()).toEqual(["Follow-up", "Newer"]);
    // A later email to the same bad address that bounces too is a new bounce.
    sendTo(id.ana, 0.1, "Third try");
    expect(guess.recordBounce({ contactId: id.ana, email: "ana.silva@gs.test" }, NOW)).toMatchObject({ ok: true, sendTitle: "Third try" });
  });

  it("never marks an email that was answered, or one that went to another address", () => {
    sendTo(id.ana, 3, "Coffee?");
    ins("interactions", { contact_id: id.ana, kind: "email", direction: "inbound", occurred_at: NOW - 2 * DAY, title: "Re: Coffee?", source: "agent", counts_for_touch: 0, created_at: NOW });
    expect(guess.recordBounce({ contactId: id.ana, email: "ana.silva@gs.test" }, NOW)).toMatchObject({ ok: true, noSend: "no_match", record: { send: null } });
    expect(guess.recordBounce({ contactId: id.ana, email: "ana.silva@gs.test", subject: "Coffee?" }, NOW)).toMatchObject({ ok: true, record: { send: null } });
    // Two addresses and no subject: Rolo cannot tell which email came back, and says so.
    ins("contact_emails", { contact_id: id.ben, email: "ben@old-firm.test", email_normalized: "ben@old-firm.test", priority: 1, source: "user", created_at: NOW });
    sendTo(id.ben, 1, "To the working address");
    const res = ok("record_email_outcome", { contactId: id.ben, email: "ben@old-firm.test", outcome: "bounced" });
    expect(res).toMatchObject({ taggedBadAddress: true, emailNoLongerCountsAsSent: null, note: expect.stringMatching(/more than one address.*subject/) });
    // An email sent from "Drafts to send" knows where it went.
    const draft = out.saveDraft({ contactId: id.ben, groupId: null, kind: "first", subject: "Via the draft", body: "Dear Ben…", source: "agent" }, NOW - 3600_000);
    if (!draft.ok) throw new Error(draft.error);
    out.markDraftSent(draft.draft.id, NOW - 1800_000);
    expect(guess.recordBounce({ contactId: id.ben, email: "ben@old-firm.test", subject: "Via the draft" }, NOW)).toMatchObject({ ok: true, record: { send: null } });
    expect(marked()).toEqual([]);
  });

  it("undoing a bounce leaves a tag that only inherited the id, and does not put back an address the owner has handled since", () => {
    sendTo(id.ana, 1, "Hello");
    const real = guess.recordBounce({ contactId: id.ana, email: "ana.silva@gs.test" }, NOW);
    if (!real.ok) throw new Error(real.error);
    const tagId = real.record.tagged!.tagId;
    rawDb.prepare("DELETE FROM tags WHERE id = ?").run(tagId);
    ins("tags", { id: tagId, name: "VIP", color: "#888", created_at: NOW });
    ins("contact_tags", { contact_id: id.ana, tag_id: tagId, created_at: NOW });
    expect(guess.undoBounce(real.record, NOW).skipped).toContain('the tag "bad address" is gone');
    expect(rows("SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = ?", id.ana)).toEqual([{ name: "VIP" }]);

    contact("Hal Moss", "Goldman Sachs", "hmoss@gs.test");
    guess.acceptGuess(id.dev, "dev.patel@gs.test", NOW);
    const bounced = guess.recordBounce({ contactId: id.dev, email: "dev.patel@gs.test" }, NOW);
    if (!bounced.ok) throw new Error(bounced.error);
    // The owner edits the contact afterwards (here: typed the address in and took it out again).
    rawDb.prepare("UPDATE contacts SET updated_at = ? WHERE id = ?").run(NOW + 60_000, id.dev);
    expect(guess.undoBounce(bounced.record, NOW + 120_000).reversed).toEqual(["made the address a suggestion again (the contact was edited since, so it was not put back)"]);
    expect(emailsOf(id.dev)).toEqual([]);
    expect(guess.suggestionFor(id.dev)!.candidates.map((c) => c.email)).toContain("dev.patel@gs.test");
  });

  it("a format an agent records cannot move a firm off the domain its real addresses are at, nor get round the owner's for the house", () => {
    const rec = ok("record_email_format", { company: "Goldman Sachs", domain: "gs-careers.test", pattern: "flast", basis: "published", note: "a careers page" });
    expect(rec.recorded).toBe(true);
    expect(guess.suggestionFor(id.dev)!.candidates).toEqual([
      { email: "dev.patel@gs.test", domain: "gs.test", pattern: "first.last", strength: "strong", evidence: "3 of the 3 addresses Rolo holds at gs.test are built this way" },
    ]);
    ok("undo_agent_action", { actionId: rec.actionId });
    firms.setFirmEmailFormat({ company: "Goldman Sachs", domain: "gs.test", pattern: "first.last", source: "user" }, NOW);
    expect(refused("record_email_format", { company: "Goldman Sachs International", domain: "evil.test", pattern: "flast", basis: "published", note: "x" })).toMatch(/You set the address format for Goldman Sachs yourself, and Goldman Sachs International is part of it/);
    expect(guess.suggestionFor(id.eve)!.candidates[0]).toMatchObject({
      email: "eve.stone@gs.test",
      strength: "strong",
      evidence: "3 of the 3 addresses Rolo holds at gs.test (from Goldman Sachs) are built this way; the format you set for Goldman Sachs",
    });
    // Even with an agent's record already on the subsidiary, the owner's word for the house wins.
    ins("firms", { company_key: "goldman sachs international", name: "Goldman Sachs International", email_domain: "evil.test", email_pattern: "flast", email_source: "agent", email_basis: "published", created_at: NOW, updated_at: NOW });
    expect(guess.suggestionFor(id.eve)!.candidates.map((c) => c.email)).toEqual(["eve.stone@gs.test"]);
  });

  it("what counts as a firm's domain: a hostname with a real ending, and not a mailbox provider in any country", () => {
    const set = (domain: string) => firms.setFirmEmailFormat({ company: "Lazard", domain, pattern: "flast", source: "user" }, NOW);
    for (const bad of ["10.0.0.1", "foo.123", `${"a".repeat(70)}.com`, "lazard.c"]) expect(set(bad), bad).toMatchObject({ ok: false, error: expect.stringMatching(/not a domain/) });
    for (const personal of ["hotmail.es", "yahoo.de", "gmail.co.uk", "live.com.au", "virginmedia.com", "mail.ru", "protonmail.ch"]) {
      expect(set(personal), personal).toMatchObject({ ok: false, error: expect.stringMatching(/mailbox provider/) });
    }
    expect(set("lazard.co.uk")).toMatchObject({ ok: true });
  });

  it("a bounced email is flagged wherever Claude reads the timeline, and a format says who recorded it", () => {
    sendTo(id.ana, 1, "Hello Ana");
    guess.recordBounce({ contactId: id.ana, email: "ana.silva@gs.test" }, NOW);
    const [ana] = ok("get_contacts", { ids: [id.ana] }).contacts as { interactions: Record<string, unknown>[] }[];
    expect(ana.interactions[0]).toMatchObject({ title: "Hello Ana", bounced: true });
    expect((ok("get_timeline", { contactId: id.ana }).entries as Record<string, unknown>[])[0]).toMatchObject({ title: "Hello Ana", bounced: true });
    expect((ok("get_timeline", {}).entries as Record<string, unknown>[])[0]).toMatchObject({ title: "Hello Ana", bounced: true });
    ok("record_email_format", { company: "Lazard", domain: "lazard.test", pattern: "flast", basis: "published", note: "x" });
    firms.setFirmEmailFormat({ company: "Goldman Sachs", domain: "gs.test", pattern: "first.last", source: "user" }, NOW);
    const companies = ok("list_companies", {}).companies as Record<string, unknown>[];
    expect(companies.find((c) => c.company === "Lazard")).toMatchObject({ emailFormat: "asilva@lazard.test", emailFormatFrom: "claude" });
    expect(companies.find((c) => c.company === "Goldman Sachs")).toMatchObject({ emailFormatFrom: "owner" });
  });
});

describe("merging and deleting people", () => {
  it("what Rolo remembers about a guess follows a merge and goes with the contact", async () => {
    const { mergeContacts } = await import("@/lib/dedupe/merge");
    guess.acceptGuess(id.dev, "dev.patel@gs.test", NOW);
    mergeContacts(rawDb, { winnerId: id.eve, loserId: id.dev, now: NOW });
    expect(rows("SELECT contact_id, status FROM email_guesses")).toEqual([{ contact_id: id.eve, status: "accepted" }]);
    expect([...guess.guessStates(id.eve)]).toEqual([["dev.patel@gs.test", "accepted"]]);
    rawDb.prepare("DELETE FROM contacts WHERE id = ?").run(id.eve);
    expect(rows("SELECT id FROM email_guesses")).toEqual([]);
  });
});
