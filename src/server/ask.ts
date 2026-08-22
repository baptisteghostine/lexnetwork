"use server";

import { eq, inArray, isNull } from "drizzle-orm";

import { db } from "@/db/client";
import { contactTags, contacts, tags, workHistory } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import {
  ASK_SYSTEM,
  askOutputFormat,
  buildAskPrompt,
  validateAskAnswer,
  type AskCandidate,
} from "@/lib/ai/ask";
import { extractJson } from "@/lib/ai/nl-filter";
import { emptyFilterSet } from "@/lib/filters/types";
import { aiEnabled, callAi } from "@/server/ai-client";
import { compileNlFilter } from "@/server/ai";
import { searchContacts } from "@/server/search";
import { runFilter } from "@/server/views";

// Ask your network (SPEC §11): two model calls with the database in
// between. Stage 1 compiles the question to a retrieval filter; the
// filter engine — not the model — selects candidates; stage 2 ranks only
// what it was shown. Fallback chain when the filter finds too little:
// full-text search on the question, then the whole network ranked warm
// contacts first. The UI reports which source fed the answer and how
// many profiles were shared.

const MAX_CANDIDATES = 50;
const MIN_FILTER_HITS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AskSource = "filter" | "search" | "network";

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
      source: AskSource;
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

function rankWarmFirst(rows: ContactRow[]): ContactRow[] {
  return [...rows].sort((a, b) => {
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    return (b.lastInteractionAt ?? -1) - (a.lastInteractionAt ?? -1);
  });
}

function toCandidates(rows: ContactRow[], now: number): AskCandidate[] {
  const ids = rows.map((r) => r.id);
  const tagRows =
    ids.length > 0
      ? db
          .select({ contactId: contactTags.contactId, name: tags.name })
          .from(contactTags)
          .innerJoin(tags, eq(tags.id, contactTags.tagId))
          .where(inArray(contactTags.contactId, ids))
          .all()
      : [];
  const historyRows =
    ids.length > 0
      ? db
          .select({
            contactId: workHistory.contactId,
            company: workHistory.company,
            title: workHistory.title,
            startDate: workHistory.startDate,
            endDate: workHistory.endDate,
          })
          .from(workHistory)
          .where(inArray(workHistory.contactId, ids))
          .all()
      : [];
  const tagsBy = new Map<number, string[]>();
  for (const t of tagRows) {
    tagsBy.set(t.contactId, [...(tagsBy.get(t.contactId) ?? []), t.name]);
  }
  const historyBy = new Map<number, string[]>();
  for (const h of historyRows) {
    const line = `${h.title ?? "?"} @ ${h.company}${h.startDate ? ` (${h.startDate}–${h.endDate ?? "now"})` : ""}`;
    historyBy.set(h.contactId, [...(historyBy.get(h.contactId) ?? []), line]);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.displayName,
    title: r.title,
    company: r.company,
    location: r.location,
    tags: tagsBy.get(r.id) ?? [],
    lastContactDays:
      r.lastInteractionAt === null
        ? null
        : Math.max(0, Math.floor((now - r.lastInteractionAt) / DAY_MS)),
    history: (historyBy.get(r.id) ?? []).slice(0, 2),
    starred: r.starred,
  }));
}

async function selectCandidates(
  question: string,
  now: number
): Promise<{ rows: ContactRow[]; source: AskSource }> {
  // Stage 1: the question as a filter — reuses NL search wholesale.
  const compiled = await compileNlFilter(question, "ask_plan");
  if (compiled.ok && compiled.filter.clauses.length > 0) {
    const result = await runFilter(compiled.filter, { now });
    if (result.contacts.length >= MIN_FILTER_HITS) {
      return { rows: rankWarmFirst(result.contacts).slice(0, MAX_CANDIDATES), source: "filter" };
    }
  }
  // Fallback: FTS over the question's words.
  const hits = searchContacts(question, MAX_CANDIDATES);
  if (hits.length >= MIN_FILTER_HITS) {
    const rows = db
      .select({
        id: contacts.id,
        displayName: contacts.displayName,
        title: contacts.title,
        company: contacts.company,
        location: contacts.location,
        starred: contacts.starred,
        lastInteractionAt: contacts.lastInteractionAt,
      })
      .from(contacts)
      .where(inArray(contacts.id, hits.slice(0, MAX_CANDIDATES).map((h) => h.id)))
      .all();
    return { rows: rankWarmFirst(rows).slice(0, MAX_CANDIDATES), source: "search" };
  }
  // Last resort: the warmest slice of the whole network.
  const rows = db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      title: contacts.title,
      company: contacts.company,
      location: contacts.location,
      starred: contacts.starred,
      lastInteractionAt: contacts.lastInteractionAt,
    })
    .from(contacts)
    .where(isNull(contacts.archivedAt))
    .all();
  return { rows: rankWarmFirst(rows).slice(0, MAX_CANDIDATES), source: "network" };
}

export async function askNetworkAction(input: {
  question: string;
}): Promise<AskResult> {
  await requireAuth();
  if (!aiEnabled()) return { error: "AI is not configured." };
  const question = input.question.trim().slice(0, 600);
  if (question.length < 5) return { error: "Ask a fuller question." };

  const now = Date.now();
  const { rows, source } = await selectCandidates(question, now);
  if (rows.length === 0) {
    return { error: "No contacts to reason over yet — import some first." };
  }
  const candidates = toCandidates(rows, now);
  const allowedIds = new Set(candidates.map((c) => c.id));
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Stage 2: rank, one retry with the validation errors (SPEC §11).
  let prompt = buildAskPrompt(question, candidates);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await callAi({
      feature: "ask_answer",
      system: ASK_SYSTEM,
      prompt,
      maxTokens: 1500,
      outputFormat: askOutputFormat(),
    });
    if (!result.ok) return { error: result.error };
    const raw = extractJson(result.text);
    const validated =
      raw === null
        ? { ok: false as const, errors: ["response was not JSON"] }
        : validateAskAnswer(raw, allowedIds);
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
        source,
      };
    }
    prompt = `${buildAskPrompt(question, candidates)}\n\nYour previous answer was invalid: ${validated.errors.join("; ")}. Return corrected JSON.`;
  }
  return { error: "The model couldn't produce a grounded answer for this — try rephrasing." };
}
