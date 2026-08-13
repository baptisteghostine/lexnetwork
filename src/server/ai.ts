"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import {
  aiCalls,
  aiSuggestions,
  contactChanges,
  contactTags,
  contacts,
  notes,
  tags,
} from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import {
  buildNlSearchSystem,
  extractJson,
  nlSearchOutputFormat,
  validateAiFilter,
  type FilterCatalog,
} from "@/lib/ai/nl-filter";
import {
  buildOpenersPrompt,
  buildSummarizePrompt,
  OPENERS_SYSTEM,
  openersFormat,
  parseOpeners,
  SUMMARIZE_MIN_CHARS,
  SUMMARIZE_SYSTEM,
  type OpenersInput,
} from "@/lib/ai/prompts";
import { encodeFilterParam } from "@/lib/filters/encode";
import { listCustomFields } from "@/server/custom-fields";
import { aiEnabled, callAi } from "@/server/ai-client";
import { untaggedContactIds } from "@/server/ai-batch";
import { enqueueJob } from "@/jobs/scheduler";
import { getContactDetail, listGroups, listTags } from "@/server/queries";

// Server actions for the AI layer (SPEC §11). Thin: prompts and validation
// live in lib/ai; every model call goes through server/ai-client (one
// ai_calls row per use); suggestions only ever land in the review queue.

export async function readAiEnabled(): Promise<boolean> {
  await requireAuth();
  return aiEnabled();
}

// ---------- natural-language search ----------

export type NlSearchResult =
  | { encoded: string; clauseCount: number }
  | { error: string; raw?: string };

function catalog(): FilterCatalog {
  return {
    tags: listTags().map((t) => ({ id: t.id, name: t.name })),
    groups: listGroups().map((g) => ({ id: g.id, name: g.name })),
    customFields: [],
  };
}

export async function nlSearchAction(input: {
  query: string;
}): Promise<NlSearchResult> {
  await requireAuth();
  if (!aiEnabled()) return { error: "AI is not configured." };
  const query = input.query.trim().slice(0, 500);
  if (!query) return { error: "Type a query first." };

  const cat = catalog();
  cat.customFields = (await listCustomFields()).map((f) => ({
    id: f.id,
    name: f.name,
    kind: f.kind,
  }));
  const system = buildNlSearchSystem(cat, Date.now());

  // One retry with the validation error appended (SPEC §11 edge case).
  let lastRaw = "";
  let prompt = query;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await callAi({
      feature: "nl_search",
      system,
      prompt,
      maxTokens: 2048,
      outputFormat: nlSearchOutputFormat(),
    });
    if (!result.ok) return { error: result.error };
    lastRaw = result.text;

    const raw = extractJson(result.text);
    const validated =
      raw === null
        ? { ok: false as const, errors: ["response was not JSON"] }
        : validateAiFilter(raw, cat);
    if (validated.ok) {
      if (validated.filter.clauses.length === 0) {
        return {
          error:
            "Couldn't map this to filters — try naming tags, companies, places, or timeframes.",
        };
      }
      return {
        encoded: encodeFilterParam(validated.filter),
        clauseCount: validated.filter.clauses.length,
      };
    }
    prompt = `${query}\n\nYour previous attempt was invalid: ${validated.errors.join("; ")}. Return corrected filter JSON.`;
  }
  return {
    error: "Couldn't compile that query into filters.",
    raw: lastRaw.slice(0, 500),
  };
}

// ---------- conversation starters ----------

export async function openersAction(input: {
  contactId: number;
  changeId?: number;
}): Promise<{ openers?: string[]; error?: string }> {
  await requireAuth();
  if (!aiEnabled()) return { error: "AI is not configured." };
  const detail = getContactDetail(input.contactId);
  if (!detail) return { error: "Contact not found." };

  const recentNotes = db
    .select({ body: notes.bodyMd })
    .from(notes)
    .where(eq(notes.contactId, input.contactId))
    .orderBy(desc(notes.createdAt))
    .limit(5)
    .all()
    .map((n) => n.body.slice(0, 500))
    .filter((b) => b.trim() !== "");

  let change: OpenersInput["change"] = null;
  if (input.changeId) {
    const row = db
      .select()
      .from(contactChanges)
      .where(eq(contactChanges.id, input.changeId))
      .get();
    if (row && row.contactId === input.contactId) {
      change = { field: row.field, oldValue: row.oldValue, newValue: row.newValue };
    }
  }

  const result = await callAi({
    feature: "openers",
    system: OPENERS_SYSTEM,
    prompt: buildOpenersPrompt({
      displayName: detail.contact.displayName,
      title: detail.contact.title,
      company: detail.contact.company,
      workHistory: detail.workHistory.map((w) => ({
        company: w.company,
        title: w.title,
        isCurrent: w.isCurrent,
      })),
      notes: recentNotes,
      change,
    }),
    maxTokens: 1024,
    outputFormat: openersFormat(),
  });
  if (!result.ok) return { error: result.error };
  const openers = parseOpeners(result.text);
  if (!openers) return { error: "The model returned an unusable response." };
  return { openers };
}

// ---------- note summarization ----------

export async function summarizeNoteAction(input: {
  noteId: number;
}): Promise<{ summary?: string; error?: string }> {
  await requireAuth();
  if (!aiEnabled()) return { error: "AI is not configured." };
  const note = db.select().from(notes).where(eq(notes.id, input.noteId)).get();
  if (!note) return { error: "Note not found." };
  if (note.bodyMd.length < SUMMARIZE_MIN_CHARS) {
    return { error: "This note is short enough to read directly." };
  }
  const result = await callAi({
    feature: "summarize",
    system: SUMMARIZE_SYSTEM,
    prompt: buildSummarizePrompt(note.bodyMd),
    maxTokens: 1024,
  });
  if (!result.ok) return { error: result.error };
  const summary = result.text.trim();
  if (!summary) return { error: "The model returned an empty summary." };
  db.update(notes)
    .set({ summaryAi: summary })
    .where(eq(notes.id, input.noteId))
    .run();
  if (note.contactId) revalidatePath(`/contacts/${note.contactId}`);
  return { summary };
}

// ---------- auto-tag batch ----------

export async function suggestTagsAction(input: {
  contactIds?: number[];
  allUntagged?: boolean;
}): Promise<{ queued?: number; error?: string }> {
  await requireAuth();
  if (!aiEnabled()) return { error: "AI is not configured." };
  const idsInput = z.array(z.number().int().positive()).max(2000);
  const ids = input.allUntagged
    ? untaggedContactIds()
    : (idsInput.safeParse(input.contactIds ?? []).data ?? []);
  if (ids.length === 0) return { error: "No contacts to tag." };
  const now = Date.now();
  enqueueJob({
    kind: "ai_batch_tag",
    runAt: now,
    payloadJson: JSON.stringify({ contactIds: ids }),
    dedupeKey: `ai_batch_tag:${Math.floor(now / 60_000)}`,
  });
  revalidatePath("/ai");
  return { queued: ids.length };
}

// ---------- suggestion queue ----------

export type SuggestionRow = {
  id: number;
  contactId: number;
  contactName: string;
  tagName: string;
  isNewTag: boolean;
  confidence: number;
  rationale: string;
  createdAt: number;
};

export async function readSuggestions(): Promise<SuggestionRow[]> {
  await requireAuth();
  const rows = db
    .select({
      id: aiSuggestions.id,
      contactId: aiSuggestions.contactId,
      payloadJson: aiSuggestions.payloadJson,
      createdAt: aiSuggestions.createdAt,
      contactName: contacts.displayName,
    })
    .from(aiSuggestions)
    .innerJoin(contacts, eq(contacts.id, aiSuggestions.contactId))
    .where(eq(aiSuggestions.status, "pending"))
    .orderBy(desc(aiSuggestions.createdAt), aiSuggestions.id)
    .limit(500)
    .all();
  const out: SuggestionRow[] = [];
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payloadJson) as {
        tagName: string;
        isNewTag: boolean;
        confidence: number;
        rationale: string;
      };
      out.push({
        id: r.id,
        contactId: r.contactId,
        contactName: r.contactName,
        tagName: p.tagName,
        isNewTag: p.isNewTag,
        confidence: p.confidence,
        rationale: p.rationale,
        createdAt: r.createdAt,
      });
    } catch {
      // Unparseable payload — leave it out rather than crash the queue.
    }
  }
  return out;
}

const AI_TAG_COLOR = "#8b5cf6";

function approveSuggestion(id: number): void {
  const row = db
    .select()
    .from(aiSuggestions)
    .where(eq(aiSuggestions.id, id))
    .get();
  if (!row || row.status !== "pending") return;
  const payload = JSON.parse(row.payloadJson) as { tagName: string };
  const existing = db
    .select()
    .from(tags)
    .all()
    .find((t) => t.name.toLowerCase() === payload.tagName.toLowerCase());
  const tagId =
    existing?.id ??
    db
      .insert(tags)
      .values({
        name: payload.tagName,
        color: AI_TAG_COLOR,
        createdAt: Date.now(),
      })
      .returning({ id: tags.id })
      .get().id;
  db.insert(contactTags)
    .values({ contactId: row.contactId, tagId, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
  db.update(aiSuggestions)
    .set({ status: "approved", resolvedAt: Date.now() })
    .where(eq(aiSuggestions.id, id))
    .run();
}

export async function resolveSuggestionsAction(input: {
  ids: number[];
  approve: boolean;
}): Promise<void> {
  await requireAuth();
  const ids = z.array(z.number().int().positive()).max(500).parse(input.ids);
  for (const id of ids) {
    if (input.approve) {
      approveSuggestion(id);
    } else {
      db.update(aiSuggestions)
        .set({ status: "rejected", resolvedAt: Date.now() })
        .where(eq(aiSuggestions.id, id))
        .run();
    }
  }
  revalidatePath("/ai");
  revalidatePath("/contacts");
}

// ---------- audit ----------

export type AiCallRow = {
  id: number;
  feature: string;
  model: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: number;
  promptPreview: string;
  responsePreview: string | null;
};

export async function readAiAudit(): Promise<{
  calls: AiCallRow[];
  totals: { calls: number; inputTokens: number; outputTokens: number };
}> {
  await requireAuth();
  const rows = db
    .select()
    .from(aiCalls)
    .orderBy(desc(aiCalls.createdAt), desc(aiCalls.id))
    .limit(100)
    .all();
  const all = db
    .select({
      inputTokens: aiCalls.inputTokens,
      outputTokens: aiCalls.outputTokens,
    })
    .from(aiCalls)
    .all();
  return {
    calls: rows.map((r) => ({
      id: r.id,
      feature: r.feature,
      model: r.model,
      status: r.status,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      latencyMs: r.latencyMs,
      error: r.error,
      createdAt: r.createdAt,
      promptPreview: r.prompt.slice(0, 400),
      responsePreview: r.response?.slice(0, 400) ?? null,
    })),
    totals: {
      calls: all.length,
      inputTokens: all.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
      outputTokens: all.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
    },
  };
}
