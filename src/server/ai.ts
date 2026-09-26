"use server";

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import {
  aiCalls,
  aiSuggestions,
  contactChanges,
  contactTags,
  contacts,
  interactions,
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
  buildDraftPrompt,
  buildDraftSystem,
  draftFormat,
  parseDraft,
  type Draft,
  type DraftInput,
} from "@/lib/ai/draft";
import {
  buildSummarizePrompt,
  SUMMARIZE_MIN_CHARS,
  SUMMARIZE_SYSTEM,
} from "@/lib/ai/prompts";
import type { ChangeTriage } from "@/lib/ai/triage";
import { DAY_MS } from "@/lib/cadence/engine";
import { interactionLabelFull } from "@/lib/prep/build";
import { readAnnotation } from "@/server/ai-annotations";
import { enrichContact } from "@/server/ai-enrich";
import { ownerVoiceContext } from "@/server/ai-voice";
import {
  VOICE_SYSTEM as VOICE_SYSTEM_PROMPT,
  buildVoicePrompt,
  hasEnoughVoiceMaterial,
  parseVoiceGuide,
  VOICE_EXAMPLES_MAX_CHARS,
  VOICE_GUIDE_MAX_CHARS,
  voiceFormat,
} from "@/lib/ai/voice";
import { encodeFilterParam } from "@/lib/filters/encode";
import { setSetting } from "@/lib/settings";
import { listCustomFields } from "@/server/custom-fields";
import { aiEnabled, callAi } from "@/server/ai-client";
import { untaggedContactIds } from "@/server/ai-batch";
import { outboundSnippets, readVoiceSettings, type VoiceSettings } from "@/server/ai-voice";
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

/**
 * Question → validated FilterSet, with one retry carrying the validation
 * error (SPEC §11 edge case). Shared by NL search and Ask's retrieval
 * stage — `feature` keeps their audit rows distinguishable.
 */
export async function compileNlFilter(
  query: string,
  feature: "nl_search" | "ask_plan"
): Promise<
  | { ok: true; filter: import("@/lib/filters/types").FilterSet }
  | { ok: false; error: string; raw?: string }
> {
  await requireAuth();
  // Exported from a "use server" module, so callable from the client with
  // anything: the audit feature is pinned to the two it can be.
  if (feature !== "nl_search" && feature !== "ask_plan") feature = "nl_search";
  const cat = catalog();
  cat.customFields = (await listCustomFields()).map((f) => ({
    id: f.id,
    name: f.name,
    kind: f.kind,
  }));
  const system = buildNlSearchSystem(cat, Date.now());

  let lastRaw = "";
  let prompt = query;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await callAi({
      feature,
      system,
      prompt,
      maxTokens: 2048,
      outputFormat: nlSearchOutputFormat(),
    });
    if (!result.ok) return { ok: false, error: result.error };
    lastRaw = result.text;

    const raw = extractJson(result.text);
    const validated =
      raw === null
        ? { ok: false as const, errors: ["response was not JSON"] }
        : validateAiFilter(raw, cat);
    if (validated.ok) return { ok: true, filter: validated.filter };
    prompt = `${query}\n\nYour previous attempt was invalid: ${validated.errors.join("; ")}. Return corrected filter JSON.`;
  }
  return {
    ok: false,
    error: "Couldn't compile that query into filters.",
    raw: lastRaw.slice(0, 500),
  };
}

export async function nlSearchAction(input: {
  query: string;
}): Promise<NlSearchResult> {
  await requireAuth();
  if (!aiEnabled()) return { error: "AI is not configured." };
  const query = input.query.trim().slice(0, 500);
  if (!query) return { error: "Type a query first." };

  const compiled = await compileNlFilter(query, "nl_search");
  if (!compiled.ok) return { error: compiled.error, raw: compiled.raw };
  if (compiled.filter.clauses.length === 0) {
    return {
      error:
        "Couldn't map this to filters — try naming tags, companies, places, or timeframes.",
    };
  }
  return {
    encoded: encodeFilterParam(compiled.filter),
    clauseCount: compiled.filter.clauses.length,
  };
}

// ---------- drafts in the owner's voice ----------

export type DraftResult =
  | {
      draft: Draft;
      /** Primary email on file, for the Gmail compose link. */
      email: string | null;
      linkedinUrl: string | null;
    }
  | { error: string };

const draftInput = z.object({
  contactId: z.number().int().positive(),
  changeId: z.number().int().positive().optional(),
  intent: z.string().trim().max(300).optional(),
});

/**
 * One draft (message + email + two alternative openings) for a contact,
 * grounded in what Rolo knows — notes, recent exchanges, a detected
 * change and its triage — and written in the owner's voice (SPEC §11,
 * 2026-09-26). Never sent from here.
 */
export async function draftMessageAction(input: {
  contactId: number;
  changeId?: number;
  intent?: string;
}): Promise<DraftResult> {
  await requireAuth();
  if (!aiEnabled()) return { error: "AI is not configured." };
  const parsed = draftInput.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  const detail = getContactDetail(parsed.data.contactId);
  if (!detail) return { error: "Contact not found." };
  const now = Date.now();

  const recentNotes = db
    .select({ body: notes.bodyMd })
    .from(notes)
    .where(eq(notes.contactId, detail.contact.id))
    .orderBy(desc(notes.createdAt))
    .limit(5)
    .all()
    .map((n) => n.body.replace(/\s+/g, " ").trim().slice(0, 500))
    .filter((b) => b !== "");
  const recent = db
    .select({
      kind: interactions.kind,
      direction: interactions.direction,
      title: interactions.title,
      meta: interactions.meta,
      occurredAt: interactions.occurredAt,
    })
    .from(interactions)
    .where(eq(interactions.contactId, detail.contact.id))
    .orderBy(desc(interactions.occurredAt))
    .limit(6)
    .all()
    .map((i) => `${interactionLabelFull(i)} · ${Math.max(0, Math.floor((now - i.occurredAt) / DAY_MS))}d ago`);
  const tagNames = new Map(listTags().map((t) => [t.id, t.name]));

  let change: DraftInput["change"] = null;
  if (parsed.data.changeId) {
    const row = db
      .select()
      .from(contactChanges)
      .where(eq(contactChanges.id, parsed.data.changeId))
      .get();
    if (row && row.contactId === detail.contact.id) {
      const triage = readAnnotation<ChangeTriage>("change_triage", row.id)?.payload ?? null;
      change = {
        field: row.field,
        oldValue: row.oldValue,
        newValue: row.newValue,
        reason: triage?.reason || null,
      };
    }
  }

  const result = await callAi({
    feature: "draft",
    system: buildDraftSystem(ownerVoiceContext()),
    prompt: buildDraftPrompt({
      displayName: detail.contact.displayName,
      firstName: detail.contact.firstName,
      title: detail.contact.title,
      company: detail.contact.company,
      location: detail.contact.location,
      workHistory: detail.workHistory.map((w) => ({
        company: w.company,
        title: w.title,
        isCurrent: w.isCurrent,
      })),
      education: detail.education.map((e) => ({ school: e.school, degree: e.degree, field: e.field })),
      tags: detail.tagIds.map((id) => tagNames.get(id)).filter((n): n is string => !!n),
      lastContactDays:
        detail.contact.lastInteractionAt === null
          ? null
          : Math.max(0, Math.floor((now - detail.contact.lastInteractionAt) / DAY_MS)),
      recentInteractions: recent,
      notes: recentNotes,
      change,
      intent: parsed.data.intent || null,
    }),
    maxTokens: 1800,
    outputFormat: draftFormat(),
  });
  if (!result.ok) return { error: result.error };
  const draft = parseDraft(result.text);
  if (!draft) return { error: "The model returned an unusable draft — try again." };
  const primary = [...detail.emails].sort((a, b) => a.priority - b.priority)[0]?.email ?? null;
  const linkedin = detail.socials.find((s) => s.platform === "linkedin")?.url ?? null;
  return { draft, email: primary, linkedinUrl: linkedin };
}

// ---------- profile enrichment ----------

/** "What I know" card for one contact, on demand (SPEC §11). */
export async function enrichContactAction(input: { contactId: number }): Promise<{ error?: string }> {
  await requireAuth();
  if (!aiEnabled()) return { error: "AI is not configured." };
  const contactId = z.number().int().positive().safeParse(input.contactId);
  if (!contactId.success) return { error: "Invalid request." };
  const result = await enrichContact(contactId.data, Date.now());
  if (!result.ok) return { error: result.error };
  revalidatePath(`/contacts/${contactId.data}`);
  return {};
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
  // Millisecond-granular key: a coarser (per-minute) key made a second
  // batch queued in the same minute silently no-op while still reporting
  // "queued" — two rapid batches are cheaper than one lost one.
  enqueueJob({
    kind: "ai_batch_tag",
    runAt: now,
    payloadJson: JSON.stringify({ contactIds: ids }),
    dedupeKey: `ai_batch_tag:${now}`,
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
      // Only pending rows can be rejected — a stale UI must not flip an
      // already-approved suggestion.
      db.update(aiSuggestions)
        .set({ status: "rejected", resolvedAt: Date.now() })
        .where(and(eq(aiSuggestions.id, id), eq(aiSuggestions.status, "pending")))
        .run();
    }
  }
  revalidatePath("/ai");
  revalidatePath("/contacts");
}

// ---------- the owner's voice ----------

export type VoiceView = VoiceSettings & { sampleCount: number };

export async function readVoice(): Promise<VoiceView> {
  await requireAuth();
  return { ...readVoiceSettings(), sampleCount: outboundSnippets().length };
}

const voiceInput = z.object({
  ownerName: z.string().trim().max(80),
  examples: z.string().max(VOICE_EXAMPLES_MAX_CHARS),
  guide: z.string().max(VOICE_GUIDE_MAX_CHARS),
});

/** Save the pasted examples, the owner's name, and the guide as edited. */
export async function saveVoiceAction(input: {
  ownerName: string;
  examples: string;
  guide: string;
}): Promise<{ error?: string }> {
  await requireAuth();
  const parsed = voiceInput.safeParse(input);
  if (!parsed.success) return { error: "Too long — trim the examples or the guide." };
  setSetting("ai.owner_name", parsed.data.ownerName || null);
  setSetting("ai.voice_examples", parsed.data.examples);
  setSetting("ai.voice_guide", parsed.data.guide.trim() || null);
  revalidatePath("/ai");
  return {};
}

/** Derive the guide from what the owner has actually sent, plus examples. */
export async function buildVoiceGuideAction(): Promise<{ guide?: string; error?: string }> {
  await requireAuth();
  if (!aiEnabled()) return { error: "AI is not configured." };
  const v = readVoiceSettings();
  const input = { snippets: outboundSnippets(), examples: v.examples, ownerName: v.ownerName };
  if (!hasEnoughVoiceMaterial(input)) {
    return {
      error:
        "Not enough material yet: import your LinkedIn ZIP with Messages, or paste a few messages you sent below.",
    };
  }
  const result = await callAi({
    feature: "voice",
    system: VOICE_SYSTEM_PROMPT,
    prompt: buildVoicePrompt(input),
    maxTokens: 1500,
    outputFormat: voiceFormat(),
  });
  if (!result.ok) return { error: result.error };
  const guide = parseVoiceGuide(result.text);
  if (!guide) return { error: "The model returned an unusable guide — try again." };
  setSetting("ai.voice_guide", guide);
  setSetting("ai.voice_generated_at", Date.now());
  revalidatePath("/ai");
  return { guide };
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
