import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  aiAnnotations,
  contactChanges,
  contacts,
  contactTags,
  notes,
  tags,
} from "@/db/schema";
import { DAY_MS } from "@/lib/cadence/engine";
import {
  buildTriagePrompt,
  buildTriageSystem,
  clampHideBelow,
  isLowSignal,
  parseTriage,
  TRIAGE_BATCH,
  triageFormat,
  type ChangeTriage,
  type TriageChange,
} from "@/lib/ai/triage";
import { getSetting } from "@/lib/settings";
import { pruneOrphanAnnotations, readAnnotations, upsertAnnotation } from "@/server/ai-annotations";
import { aiConfig, aiEnabled, callAi } from "@/server/ai-client";
import { ownerVoiceContext } from "@/server/ai-voice";

// The ai_change_triage job (SPEC §5/§11, 2026-09-26): every open change
// without a verdict gets one, in batches, and the verdict lands as an
// annotation. Runs on the scheduler's interval and right after an import
// that detected moves, so a Today card rarely shows without its reason.

const RUN_CAP = 40; // changes per run — four model calls, bounded cost

export function triageHideBelow(): number {
  return clampHideBelow(getSetting<number>("ai.triage.hide_below"));
}

/** Verdicts for a set of changes, with the fold decision applied. A null
 * payload is a change the model could not triage (see runChangeTriage):
 * it reads as untriaged and is never re-sent. */
export function triageFor(changeIds: number[]): Map<number, { triage: ChangeTriage; lowSignal: boolean }> {
  const out = new Map<number, { triage: ChangeTriage; lowSignal: boolean }>();
  if (changeIds.length === 0) return out;
  const hideBelow = triageHideBelow();
  for (const [id, a] of readAnnotations<ChangeTriage | null>("change_triage", changeIds)) {
    if (!a.payload) continue;
    out.set(id, { triage: a.payload, lowSignal: isLowSignal(a.payload, hideBelow) });
  }
  return out;
}

function untriagedChanges(now: number): TriageChange[] {
  const rows = db
    .select({
      id: contactChanges.id,
      contactId: contactChanges.contactId,
      field: contactChanges.field,
      oldValue: contactChanges.oldValue,
      newValue: contactChanges.newValue,
      displayName: contacts.displayName,
      title: contacts.title,
      company: contacts.company,
      starred: contacts.starred,
      lastInteractionAt: contacts.lastInteractionAt,
    })
    .from(contactChanges)
    .innerJoin(contacts, eq(contacts.id, contactChanges.contactId))
    .where(
      and(
        isNull(contactChanges.dismissedAt),
        isNull(contactChanges.actedAt),
        isNull(contacts.archivedAt),
        // An anti-join, not NOT IN (...ids): verdicts are never pruned, so
        // a bound list would one day cross SQLite's variable limit.
        sql`NOT EXISTS (SELECT 1 FROM ${aiAnnotations} a
              WHERE a.kind = 'change_triage' AND a.subject_id = ${contactChanges.id})`
      )
    )
    .orderBy(desc(contactChanges.detectedAt))
    .limit(RUN_CAP)
    .all();
  if (rows.length === 0) return [];

  const contactIds = [...new Set(rows.map((r) => r.contactId))];
  const tagRows = db
    .select({ contactId: contactTags.contactId, name: tags.name })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(inArray(contactTags.contactId, contactIds))
    .all();
  const tagsBy = new Map<number, string[]>();
  for (const t of tagRows) tagsBy.set(t.contactId, [...(tagsBy.get(t.contactId) ?? []), t.name]);
  const noteRows = db
    .select({ contactId: notes.contactId, body: notes.bodyMd, createdAt: notes.createdAt })
    .from(notes)
    .where(inArray(notes.contactId, contactIds))
    .orderBy(desc(notes.createdAt))
    .all();
  const lastNoteBy = new Map<number, string>();
  for (const n of noteRows) {
    if (n.contactId === null || lastNoteBy.has(n.contactId)) continue;
    const body = n.body.replace(/\s+/g, " ").trim();
    if (body) lastNoteBy.set(n.contactId, body.slice(0, 240));
  }

  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    field: r.field as "company" | "title",
    oldValue: r.oldValue,
    newValue: r.newValue,
    title: r.title,
    company: r.company,
    lastContactDays:
      r.lastInteractionAt === null ? null : Math.max(0, Math.floor((now - r.lastInteractionAt) / DAY_MS)),
    starred: r.starred,
    lastNote: lastNoteBy.get(r.contactId) ?? null,
    tags: tagsBy.get(r.contactId) ?? [],
  }));
}

export type TriageStats = {
  changes: number;
  triaged: number;
  /** Changes the model answered for but not usably — stamped as untriageable. */
  unusable: number;
  batchErrors: number;
  /** More untriaged changes remain past this run's cap. */
  more: boolean;
};

/** Ten items' worth of reasons and openers is near 2,500 tokens; reasoning
 * models also spend the cap on thinking. */
const TRIAGE_MAX_TOKENS = 6000;

/**
 * One batch: ask, parse, and on an unusable reply try each half once —
 * a cut-off reply or one malformed item should not cost the other nine
 * their verdict. Returns the verdicts won; a model/API error (429, network)
 * returns null so the batch waits for the next run instead.
 */
async function triageBatch(
  batch: TriageChange[],
  system: string,
  depth = 0
): Promise<{ verdicts: Map<number, ChangeTriage>; callId: number | null } | null> {
  const allowed = new Set(batch.map((c) => c.id));
  const result = await callAi({
    feature: "change_triage",
    system,
    prompt: buildTriagePrompt(batch),
    maxTokens: TRIAGE_MAX_TOKENS,
    outputFormat: triageFormat(),
  });
  if (!result.ok) {
    console.error("[rolo-triage] batch failed:", result.error);
    return null;
  }
  const verdicts = parseTriage(result.text, allowed);
  if (verdicts.size > 0 || batch.length < 2 || depth > 0) return { verdicts, callId: result.callId };
  const mid = Math.ceil(batch.length / 2);
  const halves = await Promise.all([
    triageBatch(batch.slice(0, mid), system, depth + 1),
    triageBatch(batch.slice(mid), system, depth + 1),
  ]);
  if (halves[0] === null && halves[1] === null) return null;
  const merged = new Map<number, ChangeTriage>();
  for (const h of halves) for (const [id, v] of h?.verdicts ?? []) merged.set(id, v);
  return { verdicts: merged, callId: halves[0]?.callId ?? halves[1]?.callId ?? null };
}

export async function runChangeTriage(now: number): Promise<TriageStats> {
  const stats: TriageStats = { changes: 0, triaged: 0, unusable: 0, batchErrors: 0, more: false };
  if (!aiEnabled()) return stats;
  // Change ids get reused once rows are deleted; a verdict left behind
  // would silently attach to the next change to take the id.
  pruneOrphanAnnotations("change_triage");
  const pending = untriagedChanges(now);
  stats.changes = pending.length;
  stats.more = pending.length === RUN_CAP;
  if (pending.length === 0) return stats;
  const model = aiConfig()?.model ?? "unknown";
  const system = buildTriageSystem(ownerVoiceContext());

  for (let i = 0; i < pending.length; i += TRIAGE_BATCH) {
    const batch = pending.slice(i, i + TRIAGE_BATCH);
    const answered = await triageBatch(batch, system);
    if (answered === null) {
      stats.batchErrors++;
      continue;
    }
    for (const [id, verdict] of answered.verdicts) {
      upsertAnnotation("change_triage", id, verdict, model, answered.callId);
      stats.triaged++;
    }
    // The model answered and still gave these nothing usable. Stamp them
    // as untriageable (a null verdict) rather than re-send the same rows
    // every quarter hour forever while newer changes queue behind them;
    // Today shows them as plain, unexplained changes.
    for (const c of batch) {
      if (answered.verdicts.has(c.id)) continue;
      upsertAnnotation("change_triage", c.id, null, model, answered.callId);
      stats.unusable++;
    }
    if (answered.verdicts.size === 0) stats.batchErrors++;
  }
  return stats;
}
