import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// SPEC §11 end to end (2026-09-26 features): every AI pipeline — voice,
// triage, drafts, the iterative Ask, profile cards, the digest brief and
// the post-meeting follow-up — run against a real migrated database with
// a fake OpenAI endpoint that answers in the exact JSON each feature
// expects, including an invented contact id in every reply so the
// validators are seen rejecting it. Nothing here needs a network or a key;
// what it proves is the wiring: prompts carry the right ids, replies land
// as annotations/notes/reminders and nowhere else, and each call logs one
// ai_calls row.

vi.mock("@/lib/auth", () => ({
  requireAuth: async () => {},
  isAuthenticated: async () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const sent: { subject: string; html: string; text: string }[] = [];
vi.mock("@/lib/digest/send", () => ({
  getSmtpSettings: () => ({ host: "h", port: 1, secure: false, user: "", pass: "", from: "a", to: "b" }),
  sendEmail: async (mail: { subject: string; html: string; text: string }) => {
    sent.push(mail);
  },
}));

const FIXTURES = path.join(__dirname, "../fixtures/linkedin");
const H = 60 * 60 * 1000;
const NOW = Date.now();

type Call = { system: string; user: string; body: Record<string, unknown> };
const calls: Call[] = [];
let quietDigest = false;

const ids = (text: string) => [...new Set([...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];

/** The fake model: routes on the system prompt and answers in each feature's schema. */
function answer(system: string, user: string): unknown {
  const first = ids(user);
  if (system.startsWith("You are describing how one specific person writes")) {
    return { guide: "You open with the first name and a dash, keep to three lines, close with Best, Baptiste." };
  }
  if (system.includes("triage job changes")) {
    // A poison batch (see the "poison" contact): the whole batch comes back
    // unusable, and so does the half that still holds the poison line.
    if (user.includes("Poison Pill") && user.includes("Stripe → Anthropic")) return { items: "garbage" };
    if (user.includes("Poison Pill")) return { items: [] };
    // The move is the line that reads "Stripe → Anthropic"; the other is a rewording.
    const items = user.split("\n").map((line) => {
      const id = ids(line)[0];
      return line.includes("Stripe → Anthropic")
        ? { id, kind: "new_company", significance: 0.9, reason: "Warm and just moved", opener: "Hi — congrats on the move." }
        : { id, kind: "noise", significance: 0.05, reason: "should be stripped", opener: "and this too" };
    });
    return { items: [...items, { id: 999, kind: "promotion", significance: 1, reason: "invented", opener: "x" }] };
  }
  if (system.includes("You write messages the owner")) {
    return {
      message: "Hi Ana — congrats on Anthropic. Coffee next week?",
      email: { subject: "Congrats", body: "Hi Ana,\n\nCongrats on the move.\n\nBest,\nBaptiste" },
      alternatives: ["Ana! Big news.", "Just saw the update — well deserved."],
    };
  }
  if (system.includes("planning how to look up people")) {
    return {
      filters: [
        { v: 1, clauses: [{ dim: "hasLinkedin", value: true }] },
        { v: 1, clauses: [{ dim: "tag", ids: [4242] }] }, // invented tag → dropped
      ],
      searches: ["Ana"],
      noteSearches: ["intro"],
      needTimeline: true,
    };
  }
  if (system.includes("You advise the owner")) {
    if (user.includes("Full timelines you asked for")) {
      const corrected = user.includes("previous answer was invalid");
      return {
        summary: "Two people fit.",
        needMore: null,
        picks: [
          { contactId: first[0], reason: "Warm and relevant." },
          ...(corrected ? [] : [{ contactId: 999, reason: "invented" }]),
        ],
      };
    }
    return { summary: "", needMore: { contactIds: [first[0], 999], why: "history" }, picks: [] };
  }
  if (system.includes("private profile card")) {
    return {
      summary: "Ana is an LBS classmate the owner messages every few weeks; she just moved to Anthropic.",
      facts: [{ label: "School", value: "LBS" }],
      relationship: { strength: 4, why: "frequent" },
      openQuestions: ["Which team at Anthropic?"],
    };
  }
  if (system.includes("morning brief")) {
    const anaLine = user.split("\n").find((l) => l.includes("Ana Silva")) ?? "";
    return {
      headline: "Ana moved, one debrief waiting",
      narrative: "Since yesterday one job change was detected. Ana moved to Anthropic and is worth a message today.",
      picks: [
        { contactId: ids(anaLine)[0] ?? first[0], why: "fresh move", draft: "Hi Ana — congrats!" },
        { contactId: 999, why: "invented", draft: "x" },
      ],
      quiet: quietDigest,
    };
  }
  if (system.includes("how a meeting went")) {
    return {
      noteMd: "- Great chat about Santander\n- I promised to send the deck",
      reminders: [
        { title: "Send the deck", dueInDays: 1, contactId: first[0] },
        { title: "Intro to Priya", dueInDays: 900, contactId: 999 },
      ],
    };
  }
  throw new Error(`fake model: unrouted system prompt: ${system.slice(0, 80)}`);
}

let dataDir: string;
let rawDb: import("better-sqlite3").Database;
let anaId: number;
let changeId: number;
let noiseChangeId: number;
let eventId: number;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rolo-ai-"));
  process.env.ROLO_DATA_DIR = dataDir;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "fake-model";
  process.env.AI_PROVIDER = "openai";

  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("https://api.openai.com/")) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const user = body.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    calls.push({ system, user, body });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(answer(system, user)) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200 }
    );
  });

  const client = await import("@/db/client");
  rawDb = client.rawDb;
  migrate(client.db, { migrationsFolder: path.join(__dirname, "../../src/db/migrations") });

  // Seed through the real import core: 4 contacts, 3 messages.
  const { parseConnections, parseMessages, parseProfileOwnerName } = await import("@/lib/imports/linkedin");
  const { executeLinkedInRows } = await import("@/server/linkedin-import");
  const read = (f: string) => fs.readFileSync(path.join(FIXTURES, f), "utf8");
  const ownerName = parseProfileOwnerName(read("Profile.csv"));
  executeLinkedInRows({
    connections: parseConnections(read("Connections.csv")),
    messages: parseMessages(read("messages.csv"), ownerName),
    ownerName,
    runKind: "linkedin_import",
    fileName: "seed.zip",
  });
  anaId = (rawDb.prepare("SELECT id FROM contacts WHERE display_name LIKE 'Ana%'").get() as { id: number }).id;
  const other = (rawDb.prepare("SELECT id FROM contacts WHERE id != ? LIMIT 1").get(anaId) as { id: number }).id;
  changeId = Number(
    rawDb
      .prepare(
        `INSERT INTO contact_changes (contact_id, field, old_value, new_value, source, detected_at) VALUES (?, 'company', 'Stripe', 'Anthropic', 'linkedin', ?)`
      )
      .run(anaId, NOW - H).lastInsertRowid
  );
  noiseChangeId = Number(
    rawDb
      .prepare(
        `INSERT INTO contact_changes (contact_id, field, old_value, new_value, source, detected_at) VALUES (?, 'title', 'Sr PM', 'Senior Product Manager', 'linkedin', ?)`
      )
      .run(other, NOW - H).lastInsertRowid
  );
  rawDb
    .prepare(`INSERT INTO notes (contact_id, body_md, counts_for_touch, created_at, updated_at) VALUES (?, 'promised an intro to Sam', 0, ?, ?)`)
    .run(anaId, NOW - 2 * H, NOW - 2 * H);
  const account = rawDb
    .prepare(
      `INSERT INTO integration_accounts (provider, account_email, scopes, status, created_at, updated_at) VALUES ('google', 'e2e@example.com', '', 'active', ?, ?)`
    )
    .run(NOW, NOW);
  eventId = Number(
    rawDb
      .prepare(
        `INSERT INTO calendar_events (event_key, account_id, summary, starts_at, ends_at, all_day, status, my_response, attendees, updated_at)
         VALUES ('evt-1', ?, 'Coffee with Ana', ?, ?, 0, 'confirmed', 'accepted', ?, ?)`
      )
      .run(account.lastInsertRowid, NOW - 3 * H, NOW - 2 * H, JSON.stringify([{ email: "ana@example.com", name: "Ana Silva", contactId: anaId }]), NOW)
      .lastInsertRowid
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
  rawDb?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("voice", () => {
  it("builds a guide from the owner's sent messages and stores it", async () => {
    const { buildVoiceGuideAction, readVoice, saveVoiceAction } = await import("@/server/ai");
    const before = await readVoice();
    expect(before.sampleCount).toBe(2); // two outbound messages in the fixture
    // Two snippets are below the material threshold; pasted examples lift it.
    expect((await buildVoiceGuideAction()).error).toMatch(/Not enough material/);
    await saveVoiceAction({ ownerName: "Baptiste", examples: "Hi Kate, it's Baptiste from LBS. ".repeat(8), guide: "" });
    const res = await buildVoiceGuideAction();
    expect(res.error).toBeUndefined();
    expect((await readVoice()).guide).toMatch(/^You open/);
    expect(calls.at(-1)!.user).toContain("2 messages they sent");
  });
});

describe("job-change triage", () => {
  it("annotates only sent ids, strips copy from noise, and folds it on Today", async () => {
    const { runChangeTriage } = await import("@/server/ai-triage");
    const stats = await runChangeTriage(NOW);
    expect(stats).toMatchObject({ changes: 2, triaged: 2, batchErrors: 0 });
    const rows = rawDb.prepare("SELECT subject_id, payload_json FROM ai_annotations WHERE kind='change_triage'").all() as { subject_id: number; payload_json: string }[];
    expect(rows.map((r) => r.subject_id).sort()).toEqual([changeId, noiseChangeId].sort());
    const noise = JSON.parse(rows.find((r) => r.subject_id === noiseChangeId)!.payload_json);
    expect(noise).toMatchObject({ kind: "noise", reason: "", opener: "" });

    const { getTodayData } = await import("@/server/today-data");
    const today = getTodayData(NOW);
    const strong = today.changes.find((c) => c.id === changeId)!;
    expect(strong.triage?.reason).toBe("Warm and just moved");
    expect(strong.lowSignal).toBe(false);
    expect(today.changes.find((c) => c.id === noiseChangeId)!.lowSignal).toBe(true);
    // A second run finds nothing left to do.
    expect((await runChangeTriage(NOW)).changes).toBe(0);
  });

  it("an unusable reply is retried by halves and the leftovers stamped, not re-sent forever", async () => {
    const { runChangeTriage } = await import("@/server/ai-triage");
    const now = Date.now();
    const poison = Number(
      rawDb
        .prepare("INSERT INTO contacts (display_name, created_at, updated_at) VALUES ('Poison Pill', ?, ?)")
        .run(now, now).lastInsertRowid
    );
    const ins = rawDb.prepare(
      "INSERT INTO contact_changes (contact_id, field, old_value, new_value, detected_at, source) VALUES (?, 'company', ?, ?, ?, 'linkedin_import')"
    );
    const poisonChange = Number(ins.run(poison, "X", "Y", now).lastInsertRowid);
    const goodChange = Number(ins.run(anaId, "Stripe", "Anthropic", now - 1).lastInsertRowid);
    const before = calls.length;

    const stats = await runChangeTriage(now);
    // First call: the pair, unusable. Then each half once: Ana's half is
    // fine, the poison half is not.
    expect(calls.length - before).toBe(3);
    expect(stats).toMatchObject({ changes: 2, triaged: 1, unusable: 1, more: false });
    const verdicts = rawDb
      .prepare("SELECT subject_id, payload_json FROM ai_annotations WHERE kind='change_triage' AND subject_id IN (?, ?)")
      .all(poisonChange, goodChange) as { subject_id: number; payload_json: string }[];
    expect(verdicts.find((v) => v.subject_id === goodChange)?.payload_json).toContain("new_company");
    expect(verdicts.find((v) => v.subject_id === poisonChange)?.payload_json).toBe("null");

    // The next run has nothing to send: the poison change is stamped, and
    // Today shows it as a plain untriaged change.
    const again = await runChangeTriage(now);
    expect(again.changes).toBe(0);
    const { getTodayData } = await import("@/server/today-data");
    const shown = getTodayData(now).changes.find((c) => c.id === poisonChange);
    expect(shown).toBeDefined();
    expect(shown!.triage).toBeNull();
    rawDb.prepare("DELETE FROM contact_changes WHERE id IN (?, ?)").run(poisonChange, goodChange);
  });
});

describe("drafts", () => {
  it("returns a draft grounded in the change and the contact's channels", async () => {
    const { draftMessageAction } = await import("@/server/ai");
    const res = await draftMessageAction({ contactId: anaId, changeId, intent: "coffee" });
    expect("draft" in res).toBe(true);
    if (!("draft" in res)) return;
    expect(res.draft.alternatives).toHaveLength(2);
    expect(res.linkedinUrl).toContain("linkedin.com/in/");
    const prompt = calls.at(-1)!.user;
    expect(prompt).toContain("Detected change — the reason to write: company Stripe → Anthropic. Why now: Warm and just moved");
    expect(prompt).toContain("The owner's intent for this message: coffee");
    expect(prompt).toContain("promised an intro to Sam");
  });
});

describe("iterative Ask", () => {
  it("plans, runs the plan, reads timelines on request, and answers with validated ids", async () => {
    const { askNetworkAction } = await import("@/server/ask");
    const res = await askNetworkAction({ question: "who can intro me to Anthropic" });
    expect("picks" in res).toBe(true);
    if (!("picks" in res)) return;
    expect(res.picks.map((p) => p.contactId)).toEqual([anaId]);
    // Four contacts in the fixture is under the five-candidate floor, so the
    // warm fallback tops up — and says so.
    expect(res.steps.map((s) => s.kind)).toEqual(["filter", "search", "notes", "warm", "timeline"]);
    expect(res.steps.find((s) => s.kind === "timeline")?.hits).toBe(1);
    // plan → answer (asks for more) → step (invented id rejected) → step (corrected)
    expect(calls.slice(-4).every((c) => c.body.model === "fake-model")).toBe(true);
    expect(calls.at(-1)!.user).toContain("previous answer was invalid: contactId 999 was not in the candidate list");
  });
});

describe("profile cards", () => {
  it("writes a card on demand and the job picks up stale contacts", async () => {
    const { enrichContactAction } = await import("@/server/ai");
    const { readProfileCard, staleContactIds, runEnrichJob } = await import("@/server/ai-enrich");
    expect((await enrichContactAction({ contactId: anaId })).error).toBeUndefined();
    expect(readProfileCard(anaId)?.payload.relationship.strength).toBe(4);
    // Ana is fresh; the other contacts with exchanges are stale.
    expect(staleContactIds(NOW)).not.toContain(anaId);
    const stats = await runEnrichJob(NOW);
    expect(stats.errors).toBe(0);
    expect(staleContactIds(NOW)).toEqual([]);
  });
});

describe("digest brief", () => {
  it("leads with the brief, links validated picks, and honours only-when-changed", async () => {
    const { buildTodayDigest, runDigest } = await import("@/jobs/digest");
    const { setSetting } = await import("@/lib/settings");
    const email = await buildTodayDigest(NOW);
    expect(email.brief?.picks.map((p) => p.contactId)).toEqual([anaId]);
    expect(email.subject).toContain("Ana moved, one debrief waiting");
    expect(email.html).toContain(`/contacts/${anaId}`);
    expect(email.html.indexOf("Since yesterday")).toBeLessThan(email.html.indexOf("Job changes"));
    // The folded change is left out of the email; the strong one carries its reason.
    expect(email.text).not.toContain("Senior Product Manager");
    expect(email.text).toContain("Warm and just moved");

    quietDigest = true;
    setSetting("digest.only_when_changed", true);
    expect(await runDigest(NOW)).toBe("skipped-quiet");
    quietDigest = false;
    expect(await runDigest(NOW)).toBe("sent");
    expect(sent).toHaveLength(1);
    const { getSetting } = await import("@/lib/settings");
    expect(getSetting<number>("digest.last_sent_at")).toBe(NOW);
  });
});

describe("post-meeting follow-up", () => {
  it("shows the card, turns one line into a note and reminders, then hides it", async () => {
    const { getTodayData } = await import("@/server/today-data");
    expect(getTodayData(NOW).followups.map((f) => f.id)).toEqual([eventId]);

    const { captureFollowupAction } = await import("@/server/followups");
    const res = await captureFollowupAction({ eventId, text: "great chat, send deck tmrw" });
    expect(res.error).toBeUndefined();
    expect(res.reminders).toBe(2);
    const note = rawDb.prepare("SELECT body_md, contact_id, counts_for_touch FROM notes WHERE id = ?").get(res.noteId) as {
      body_md: string;
      contact_id: number;
      counts_for_touch: number;
    };
    expect(note.contact_id).toBe(anaId);
    expect(note.body_md).toContain("- Great chat about Santander");
    expect(note.counts_for_touch).toBe(0);
    const reminders = rawDb.prepare("SELECT title, contact_id, due_at FROM reminders ORDER BY id").all() as { title: string; contact_id: number; due_at: number }[];
    expect(reminders.map((r) => r.title)).toEqual(["Send the deck", "Intro to Priya"]);
    expect(reminders.every((r) => r.contact_id === anaId)).toBe(true); // 999 fell back to the attendee
    expect(reminders[1].due_at - reminders[0].due_at).toBe(364 * 24 * H); // 900 clamped to 365
    expect(getTodayData(NOW).followups).toEqual([]);
  });

  it("saves the owner's words verbatim when the model fails", async () => {
    const ev2 = Number(
      rawDb
        .prepare(
          `INSERT INTO calendar_events (event_key, account_id, summary, starts_at, ends_at, all_day, status, my_response, attendees, updated_at)
           VALUES ('evt-2', 1, 'Lunch', ?, ?, 0, 'confirmed', 'accepted', ?, ?)`
        )
        .run(NOW - 5 * H, NOW - 4 * H, JSON.stringify([{ email: "ana@example.com", name: "Ana Silva", contactId: anaId }]), NOW).lastInsertRowid
    );
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 }));
    const { captureFollowupAction } = await import("@/server/followups");
    const res = await captureFollowupAction({ eventId: ev2, text: "raw words here" });
    vi.stubGlobal("fetch", realFetch);
    expect(res.error).toBeUndefined();
    const note = rawDb.prepare("SELECT body_md FROM notes WHERE id = ?").get(res.noteId) as { body_md: string };
    expect(note.body_md).toBe("raw words here");
  });
});

describe("audit", () => {
  it("logged one success row per model call with the feature names", () => {
    const rows = rawDb.prepare("SELECT feature, status FROM ai_calls ORDER BY id").all() as { feature: string; status: string }[];
    const features = new Set(rows.map((r) => r.feature));
    for (const f of ["voice", "change_triage", "draft", "ask_plan", "ask_answer", "ask_step", "enrich", "digest", "followup"]) {
      expect(features.has(f), f).toBe(true);
    }
    expect(rows.filter((r) => r.status === "error").map((r) => r.feature)).toEqual(["followup"]); // the deliberate 429
  });
});
