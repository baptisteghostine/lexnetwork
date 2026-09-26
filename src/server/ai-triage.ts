import "server-only";

import { and, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";

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
import { readAnnotations, upsertAnnotation } from "@/server/ai-annotations";
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

/** Verdicts for a set of changes, with the fold decision applied. */
export function triageFor(changeIds: number[]): Map<number, { triage: ChangeTriage; lowSignal: boolean }> {
  const out = new Map<number, { triage: ChangeTriage; lowSignal: boolean }>();
  if (changeIds.length === 0) return out;
  const hideBelow = triageHideBelow();
  for (const [id, a] of readAnnotations<ChangeTriage>("change_triage", changeIds)) {
    out.set(id, { triage: a.payload, lowSignal: isLowSignal(a.payload, hideBelow) });
  }
  return out;
}

function untriagedChanges(now: number): TriageChange[] {
  const triaged = db
    .select({ id: aiAnnotations.subjectId })
    .from(aiAnnotations)
    .where(eq(aiAnnotations.kind, "change_triage"))
    .all()
    .map((r) => r.id);
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
        triaged.length > 0 ? notInArray(contactChanges.id, triaged) : undefined
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

export type TriageStats = { changes: number; triaged: number; batchErrors: number };

export async function runChangeTriage(now: number): Promise<TriageStats> {
  const stats: TriageStats = { changes: 0, triaged: 0, batchErrors: 0 };
  if (!aiEnabled()) return stats;
  const pending = untriagedChanges(now);
  stats.changes = pending.length;
  if (pending.length === 0) return stats;
  const model = aiConfig()?.model ?? "unknown";
  const system = buildTriageSystem(ownerVoiceContext());

  for (let i = 0; i < pending.length; i += TRIAGE_BATCH) {
    const batch = pending.slice(i, i + TRIAGE_BATCH);
    const allowed = new Set(batch.map((c) => c.id));
    const result = await callAi({
      feature: "change_triage",
      system,
      prompt: buildTriagePrompt(batch),
      maxTokens: 2500,
      outputFormat: triageFormat(),
    });
    if (!result.ok) {
      stats.batchErrors++;
      console.error("[rolo-triage] batch failed:", result.error);
      continue;
    }
    const verdicts = parseTriage(result.text, allowed);
    for (const [id, verdict] of verdicts) {
      upsertAnnotation("change_triage", id, verdict, model, result.callId);
      stats.triaged++;
    }
    if (verdicts.size === 0) stats.batchErrors++;
  }
  return stats;
}
