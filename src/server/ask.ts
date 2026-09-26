"use server";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { db } from "@/db/client";
import { contactTags, contacts, interactions, notes, tags, workHistory } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import {
  ASK_SYSTEM,
  askOutputFormat,
  buildAskPrompt,
  validateAskAnswer,
  type AskCandidate,
} from "@/lib/ai/ask";
import {
  askPlanFormat,
  buildAskPlanSystem,
  buildTimelineAppendix,
  parseNeedMore,
  validateAskPlan,
  type AskPlan,
  type AskStep,
  type TimelineExcerpt,
} from "@/lib/ai/ask-plan";
import { buildNlSearchSystem, extractJson, type FilterCatalog } from "@/lib/ai/nl-filter";
import { DAY_MS } from "@/lib/cadence/engine";
import { interactionLabelFull } from "@/lib/prep/build";
import { aiEnabled, callAi } from "@/server/ai-client";
import { listCustomFields } from "@/server/custom-fields";
import { listGroups, listTags } from "@/server/queries";
import { searchContacts, searchNotes } from "@/server/search";
import { runFilter } from "@/server/views";

// Ask your network (SPEC §11, rewritten 2026-09-26 as the iterative Ask).
// Three to four model calls with the database in between:
//   1. plan  — the question becomes a retrieval plan: compiled filters,
//              keyword searches over contacts, searches over the owner's
//              notes (ask_plan; validated like NL search).
//   2. run   — the database executes the plan; the union, warm-ranked and
//              capped, is the candidate list, each with note snippets and
//              recent exchanges.
//   3. answer — the model ranks and argues over exactly that list
//              (ask_answer). It may instead ask once for the full
//              timelines of up to six candidates;
//   4. step  — those are appended and it answers (ask_step).
// Recommended ids are validated against the sent set at every turn. The
// panel shows every step the database ran and how many people each found.

const MAX_CANDIDATES = 60;
const MIN_CANDIDATES = 5;
const FILTER_LIMIT = 40;
const SEARCH_LIMIT = 20;
const NOTE_LIMIT = 10;

export type AskPick = {
  contactId: number;
  name: string;
  title: string | null;
  company: string | null;
  reason: string;
};

export type AskResult =
  | {
      summary: string;
      picks: AskPick[];
      candidateCount: number;
      steps: AskStep[];
    }
  | { error: string };

type ContactRow = {
  id: number;
  displayName: string;
  title: string | null;
  company: string | null;
  location: string | null;
  starred: boolean;
  lastInteractionAt: number | null;
};

const ROW = {
  id: contacts.id,
  displayName: contacts.displayName,
  title: contacts.title,
  company: contacts.company,
  location: contacts.location,
  starred: contacts.starred,
  lastInteractionAt: contacts.lastInteractionAt,
};

function rankWarmFirst(rows: ContactRow[]): ContactRow[] {
  return [...rows].sort((a, b) => {
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    return (b.lastInteractionAt ?? -1) - (a.lastInteractionAt ?? -1);
  });
}

function catalog(): FilterCatalog {
  return {
    tags: listTags().map((t) => ({ id: t.id, name: t.name })),
    groups: listGroups().map((g) => ({ id: g.id, name: g.name })),
    customFields: [],
  };
}

function describeFilter(plan: AskPlan, i: number): string {
  return plan.filters[i].clauses
    .map((c) => {
      switch (c.dim) {
        case "company":
          return `${c.mode === "any" ? "" : `${c.mode} `}company ~ ${c.value}`;
        case "titleContains":
          return `title/company ~ ${c.value}`;
        case "educationContains":
          return `education ~ ${c.value}`;
        case "lastInteraction":
          return c.op === "never" ? "never spoken" : `last contact ${c.op} ${c.at ? new Date(c.at).toISOString().slice(0, 10) : "?"}`;
        case "tag":
          return `tags ${c.ids.join(",")}`;
        case "group":
          return `groups ${c.ids.join(",")}`;
        case "locationRadius":
          return `within ${c.km}km`;
        default:
          return c.dim;
      }
    })
    .join(" AND ");
}

async function runPlan(
  plan: AskPlan,
  now: number
): Promise<{ rows: ContactRow[]; noteSnippets: Map<number, string[]>; steps: AskStep[] }> {
  const steps: AskStep[] = [];
  const ordered: number[] = [];
  const byId = new Map<number, ContactRow>();
  const add = (row: ContactRow) => {
    if (!byId.has(row.id)) {
      byId.set(row.id, row);
      ordered.push(row.id);
    }
  };

  for (const [i, filter] of plan.filters.entries()) {
    const result = await runFilter(filter, { now, limit: FILTER_LIMIT });
    for (const r of rankWarmFirst(result.contacts)) add(r);
    steps.push({ kind: "filter", label: describeFilter(plan, i), hits: result.total });
  }
  const pendingIds = new Set<number>();
  for (const q of plan.searches) {
    const hits = searchContacts(q, SEARCH_LIMIT);
    for (const h of hits) if (!byId.has(h.id)) pendingIds.add(h.id);
    steps.push({ kind: "search", label: q, hits: hits.length });
  }
  const noteSnippets = new Map<number, string[]>();
  for (const q of plan.noteSearches) {
    const hits = searchNotes(q, NOTE_LIMIT);
    for (const h of hits) {
      if (!byId.has(h.contactId)) pendingIds.add(h.contactId);
      const list = noteSnippets.get(h.contactId) ?? [];
      if (list.length < 2 && !list.includes(h.snippet)) list.push(h.snippet);
      noteSnippets.set(h.contactId, list);
    }
    steps.push({ kind: "notes", label: q, hits: hits.length });
  }
  if (pendingIds.size > 0) {
    const rows = db
      .select(ROW)
      .from(contacts)
      .where(and(inArray(contacts.id, [...pendingIds]), isNull(contacts.archivedAt)))
      .all();
    for (const r of rankWarmFirst(rows)) add(r);
  }
  if (ordered.length < MIN_CANDIDATES) {
    // Too little to reason over: top up with the warmest slice of the
    // whole network, and say so.
    const rows = rankWarmFirst(
      db.select(ROW).from(contacts).where(isNull(contacts.archivedAt)).all()
    ).slice(0, MAX_CANDIDATES);
    let added = 0;
    for (const r of rows) {
      if (ordered.length >= MAX_CANDIDATES) break;
      if (!byId.has(r.id)) {
        add(r);
        added++;
      }
    }
    steps.push({ kind: "warm", label: "warmest contacts", hits: added });
  }
  return { rows: ordered.slice(0, MAX_CANDIDATES).map((id) => byId.get(id)!), noteSnippets, steps };
}

function toCandidates(
  rows: ContactRow[],
  now: number,
  noteSnippets: Map<number, string[]>,
  needTimeline: boolean
): AskCandidate[] {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const tagRows = db
    .select({ contactId: contactTags.contactId, name: tags.name })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(inArray(contactTags.contactId, ids))
    .all();
  const historyRows = db
    .select({
      contactId: workHistory.contactId,
      company: workHistory.company,
      title: workHistory.title,
      startDate: workHistory.startDate,
      endDate: workHistory.endDate,
    })
    .from(workHistory)
    .where(inArray(workHistory.contactId, ids))
    .all();
  const noteRows = db
    .select({ contactId: notes.contactId, body: notes.bodyMd })
    .from(notes)
    .where(inArray(notes.contactId, ids))
    .orderBy(desc(notes.createdAt))
    .all();
  const recentRows = db
    .select({
      contactId: interactions.contactId,
      kind: interactions.kind,
      direction: interactions.direction,
      title: interactions.title,
      meta: interactions.meta,
      occurredAt: interactions.occurredAt,
    })
    .from(interactions)
    .where(inArray(interactions.contactId, ids))
    .orderBy(desc(interactions.occurredAt))
    .all();

  const tagsBy = new Map<number, string[]>();
  for (const t of tagRows) tagsBy.set(t.contactId, [...(tagsBy.get(t.contactId) ?? []), t.name]);
  const historyBy = new Map<number, string[]>();
  for (const h of historyRows) {
    const line = `${h.title ?? "?"} @ ${h.company}${h.startDate ? ` (${h.startDate}–${h.endDate ?? "now"})` : ""}`;
    historyBy.set(h.contactId, [...(historyBy.get(h.contactId) ?? []), line]);
  }
  const lastNoteBy = new Map<number, string>();
  for (const n of noteRows) {
    if (n.contactId === null || lastNoteBy.has(n.contactId)) continue;
    const body = n.body.replace(/\s+/g, " ").trim();
    if (body) lastNoteBy.set(n.contactId, body.slice(0, 160));
  }
  const recentBy = new Map<number, string[]>();
  const recentMax = needTimeline ? 3 : 1;
  for (const i of recentRows) {
    const list = recentBy.get(i.contactId) ?? [];
    if (list.length >= recentMax) continue;
    list.push(`${interactionLabelFull(i)} · ${Math.max(0, Math.floor((now - i.occurredAt) / DAY_MS))}d ago`);
    recentBy.set(i.contactId, list);
  }

  return rows.map((r) => {
    const snippets = [...(noteSnippets.get(r.id) ?? [])];
    const last = lastNoteBy.get(r.id);
    if (last && !snippets.some((s) => last.startsWith(s.slice(0, 20)))) snippets.push(last);
    return {
      id: r.id,
      name: r.displayName,
      title: r.title,
      company: r.company,
      location: r.location,
      tags: tagsBy.get(r.id) ?? [],
      lastContactDays:
        r.lastInteractionAt === null ? null : Math.max(0, Math.floor((now - r.lastInteractionAt) / DAY_MS)),
      history: (historyBy.get(r.id) ?? []).slice(0, 2),
      starred: r.starred,
      notes: snippets.slice(0, 2),
      recent: recentBy.get(r.id) ?? [],
    };
  });
}

function timelineExcerpts(ids: number[], rows: Map<number, ContactRow>, now: number): TimelineExcerpt[] {
  return ids.map((id) => {
    const recent = db
      .select({
        kind: interactions.kind,
        direction: interactions.direction,
        title: interactions.title,
        meta: interactions.meta,
        occurredAt: interactions.occurredAt,
      })
      .from(interactions)
      .where(eq(interactions.contactId, id))
      .orderBy(desc(interactions.occurredAt))
      .limit(10)
      .all()
      .map((i) => `${interactionLabelFull(i)} · ${Math.max(0, Math.floor((now - i.occurredAt) / DAY_MS))}d ago`);
    const ownerNotes = db
      .select({ body: notes.bodyMd })
      .from(notes)
      .where(eq(notes.contactId, id))
      .orderBy(desc(notes.createdAt))
      .limit(5)
      .all()
      .map((n) => n.body.replace(/\s+/g, " ").trim().slice(0, 400))
      .filter((b) => b !== "");
    return { contactId: id, name: rows.get(id)?.displayName ?? `#${id}`, interactions: recent, notes: ownerNotes };
  });
}

async function planRetrieval(question: string, now: number): Promise<AskPlan> {
  const cat = catalog();
  cat.customFields = (await listCustomFields()).map((f) => ({ id: f.id, name: f.name, kind: f.kind }));
  const result = await callAi({
    feature: "ask_plan",
    system: buildAskPlanSystem(buildNlSearchSystem(cat, now)),
    prompt: question,
    maxTokens: 2048,
    outputFormat: askPlanFormat(),
  });
  const plan = result.ok ? validateAskPlan(extractJson(result.text), cat) : null;
  // A plan that failed to compile still leaves the question's own words:
  // keyword search over contacts and notes is always a sane place to look.
  return (
    plan ?? { filters: [], searches: [question.slice(0, 80)], noteSearches: [question.slice(0, 80)], needTimeline: false }
  );
}

export async function askNetworkAction(input: { question: string }): Promise<AskResult> {
  await requireAuth();
  if (!aiEnabled()) return { error: "AI is not configured." };
  const question = input.question.trim().slice(0, 600);
  if (question.length < 5) return { error: "Ask a fuller question." };

  const now = Date.now();
  const plan = await planRetrieval(question, now);
  const { rows, noteSnippets, steps } = await runPlan(plan, now);
  if (rows.length === 0) {
    return { error: "No contacts to reason over yet — import some first." };
  }
  const candidates = toCandidates(rows, now, noteSnippets, plan.needTimeline);
  const allowedIds = new Set(candidates.map((c) => c.id));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const basePrompt = buildAskPrompt(question, candidates);
  let prompt = basePrompt;
  let feature: "ask_answer" | "ask_step" = "ask_answer";
  let askedForMore = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await callAi({
      feature,
      system: ASK_SYSTEM,
      prompt,
      maxTokens: 1800,
      outputFormat: askOutputFormat(),
    });
    if (!result.ok) return { error: result.error };
    const raw = extractJson(result.text);

    const more = askedForMore ? null : parseNeedMore(raw, allowedIds);
    if (more) {
      askedForMore = true;
      const appendix = buildTimelineAppendix(timelineExcerpts(more, byId, now));
      prompt = `${basePrompt}\n\nFull timelines you asked for:\n${appendix}\n\nNow answer.`;
      feature = "ask_step";
      steps.push({ kind: "timeline", label: "timelines read", hits: more.length });
      continue;
    }

    const validated =
      raw === null ? { ok: false as const, errors: ["response was not JSON"] } : validateAskAnswer(raw, allowedIds);
    if (validated.ok) {
      return {
        summary: validated.answer.summary,
        picks: validated.answer.picks.map((p) => {
          const row = byId.get(p.contactId)!;
          return {
            contactId: p.contactId,
            name: row.displayName,
            title: row.title,
            company: row.company,
            reason: p.reason,
          };
        }),
        candidateCount: candidates.length,
        steps,
      };
    }
    prompt = `${prompt}\n\nYour previous answer was invalid: ${validated.errors.join("; ")}. Return corrected JSON.`;
  }
  return { error: "The model couldn't produce a grounded answer for this — try rephrasing." };
}
