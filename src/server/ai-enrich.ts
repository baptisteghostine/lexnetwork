import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  aiAnnotations,
  contactChanges,
  contactTags,
  contacts,
  customFields,
  customFieldValues,
  education,
  groupMembers,
  groups,
  interactions,
  notes,
  tags,
  workHistory,
} from "@/db/schema";
import {
  buildEnrichPrompt,
  ENRICH_SYSTEM,
  enrichFormat,
  hasEnrichMaterial,
  parseEnrichment,
  type EnrichedProfile,
  type EnrichInput,
} from "@/lib/ai/enrich";
import { DAY_MS } from "@/lib/cadence/engine";
import { interactionLabelFull } from "@/lib/prep/build";
import { getSetting } from "@/lib/settings";
import { readAnnotation, upsertAnnotation, type Annotation } from "@/server/ai-annotations";
import { aiConfig, aiEnabled, callAi } from "@/server/ai-client";

// Profile enrichment (SPEC §11, 2026-09-26): the "what I know" card.
// Built on demand from the profile, and by the ai_enrich job for
// contacts whose data moved since their card was written — a new note,
// exchange, capture or change. Stored as the contact_profile annotation;
// never a contact field.

const RUN_CAP = 20;

export type ProfileCard = EnrichedProfile & { basedOn: { notes: number; exchanges: number } };

export function enrichEnabled(): boolean {
  return getSetting<boolean>("ai.enrich.enabled") ?? true;
}

export function readProfileCard(contactId: number): Annotation<ProfileCard> | null {
  return readAnnotation<ProfileCard>("contact_profile", contactId);
}

function loadInput(contactId: number, now: number): EnrichInput | null {
  const c = db.select().from(contacts).where(eq(contacts.id, contactId)).get();
  if (!c) return null;
  const history = db
    .select()
    .from(workHistory)
    .where(eq(workHistory.contactId, contactId))
    .orderBy(desc(workHistory.isCurrent), desc(workHistory.startDate))
    .limit(8)
    .all();
  const edu = db.select().from(education).where(eq(education.contactId, contactId)).limit(5).all();
  const tagNames = db
    .select({ name: tags.name })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(eq(contactTags.contactId, contactId))
    .all()
    .map((t) => t.name);
  const groupNames = db
    .select({ name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(eq(groupMembers.contactId, contactId))
    .all()
    .map((g) => g.name);
  const defs = new Map(db.select().from(customFields).all().map((f) => [f.id, f]));
  const fields = db
    .select()
    .from(customFieldValues)
    .where(eq(customFieldValues.contactId, contactId))
    .all()
    .map((v) => {
      const def = defs.get(v.customFieldId);
      const value =
        v.valueText ??
        (v.valueNumber !== null ? String(v.valueNumber) : null) ??
        (v.valueDate !== null ? new Date(v.valueDate).toISOString().slice(0, 10) : null) ??
        (v.valueJson ? String(v.valueJson) : null);
      return def && value ? { name: def.name, value: value.slice(0, 120) } : null;
    })
    .filter((f): f is { name: string; value: string } => f !== null);
  const ownerNotes = db
    .select({ body: notes.bodyMd })
    .from(notes)
    .where(eq(notes.contactId, contactId))
    .orderBy(desc(notes.createdAt))
    .limit(12)
    .all()
    .map((n) => n.body.replace(/\s+/g, " ").trim().slice(0, 500))
    .filter((b) => b !== "");
  const counts = db
    .select({
      total: sql<number>`count(*)`,
      firstAt: sql<number | null>`min(${interactions.occurredAt})`,
      lastAt: sql<number | null>`max(${interactions.occurredAt})`,
    })
    .from(interactions)
    .where(eq(interactions.contactId, contactId))
    .get();
  const recent = db
    .select({
      kind: interactions.kind,
      direction: interactions.direction,
      title: interactions.title,
      meta: interactions.meta,
      occurredAt: interactions.occurredAt,
    })
    .from(interactions)
    .where(eq(interactions.contactId, contactId))
    .orderBy(desc(interactions.occurredAt))
    .limit(8)
    .all()
    .map((i) => `${interactionLabelFull(i)} · ${Math.max(0, Math.floor((now - i.occurredAt) / DAY_MS))}d ago`);
  const changes = db
    .select({
      field: contactChanges.field,
      oldValue: contactChanges.oldValue,
      newValue: contactChanges.newValue,
      detectedAt: contactChanges.detectedAt,
    })
    .from(contactChanges)
    .where(eq(contactChanges.contactId, contactId))
    .orderBy(desc(contactChanges.detectedAt))
    .limit(4)
    .all();

  return {
    displayName: c.displayName,
    title: c.title,
    company: c.company,
    location: c.location,
    bio: c.bio,
    workHistory: history.map((w) => ({
      company: w.company,
      title: w.title,
      startDate: w.startDate,
      endDate: w.endDate,
      isCurrent: w.isCurrent,
    })),
    education: edu.map((e) => ({ school: e.school, degree: e.degree, field: e.field, endYear: e.endYear })),
    tags: tagNames,
    groups: groupNames,
    customFields: fields,
    notes: ownerNotes,
    exchanges: {
      total: counts?.total ?? 0,
      firstAt: counts?.firstAt ?? null,
      lastAt: counts?.lastAt ?? null,
      recent,
    },
    changes,
    now,
  };
}

export async function enrichContact(
  contactId: number,
  now: number
): Promise<{ ok: true; card: ProfileCard } | { ok: false; error: string }> {
  if (!aiEnabled()) return { ok: false, error: "AI is not configured." };
  const input = loadInput(contactId, now);
  if (!input) return { ok: false, error: "Contact not found." };
  if (!hasEnrichMaterial(input)) {
    return { ok: false, error: "Nothing to summarise yet — add a note or log an interaction first." };
  }
  const result = await callAi({
    feature: "enrich",
    system: ENRICH_SYSTEM,
    prompt: buildEnrichPrompt(input),
    maxTokens: 1500,
    outputFormat: enrichFormat(),
  });
  if (!result.ok) return { ok: false, error: result.error };
  const parsed = parseEnrichment(result.text);
  if (!parsed) return { ok: false, error: "The model returned an unusable profile — try again." };
  const card: ProfileCard = {
    ...parsed,
    basedOn: { notes: input.notes.length, exchanges: input.exchanges.total },
  };
  upsertAnnotation("contact_profile", contactId, card, aiConfig()?.model ?? "unknown", result.callId);
  return { ok: true, card };
}

/**
 * Contacts whose card is missing or older than their newest data. Starred
 * and cadenced people first, so the owner's closer circle is always
 * current; the rest follow over successive runs.
 */
export function staleContactIds(now: number, cap = RUN_CAP): number[] {
  const cards = new Map(
    db
      .select({ id: aiAnnotations.subjectId, updatedAt: aiAnnotations.updatedAt })
      .from(aiAnnotations)
      .where(eq(aiAnnotations.kind, "contact_profile"))
      .all()
      .map((r) => [r.id, r.updatedAt])
  );
  // Newest data point per contact: the contact row, its newest note, its
  // newest interaction — one query each, then merged in memory. Notes go
  // by updated_at: a post-meeting debrief is dated to the meeting, which
  // may be older than the card, but it was written just now.
  const rows = db
    .select({
      id: contacts.id,
      updatedAt: contacts.updatedAt,
      starred: contacts.starred,
      cadence: contacts.cadenceDays,
      title: contacts.title,
      company: contacts.company,
    })
    .from(contacts)
    .where(isNull(contacts.archivedAt))
    .all();
  const latestNote = new Map(
    db
      .select({ contactId: notes.contactId, at: sql<number>`max(${notes.updatedAt})` })
      .from(notes)
      .groupBy(notes.contactId)
      .all()
      .filter((r) => r.contactId !== null)
      .map((r) => [r.contactId as number, r.at])
  );
  const withWork = new Set(
    db.selectDistinct({ contactId: workHistory.contactId }).from(workHistory).all().map((r) => r.contactId)
  );
  const latestInteraction = new Map(
    db
      .select({ contactId: interactions.contactId, at: sql<number>`max(${interactions.createdAt})` })
      .from(interactions)
      .groupBy(interactions.contactId)
      .all()
      .map((r) => [r.contactId, r.at])
  );
  const stale = rows
    .map((r) => {
      const newest = Math.max(r.updatedAt, latestNote.get(r.id) ?? 0, latestInteraction.get(r.id) ?? 0);
      const card = cards.get(r.id);
      // Mirrors hasEnrichMaterial: a captured LinkedIn profile with a
      // role and a work history is worth a card before any note exists.
      const hasData =
        latestNote.has(r.id) || latestInteraction.has(r.id) || withWork.has(r.id) || !!(r.title && r.company);
      return { id: r.id, priority: (r.starred ? 2 : 0) + (r.cadence !== null ? 1 : 0), stale: hasData && (card === undefined || card < newest), newest };
    })
    .filter((r) => r.stale && r.newest <= now)
    .sort((a, b) => b.priority - a.priority || b.newest - a.newest);
  return stale.slice(0, cap).map((r) => r.id);
}

export type EnrichJobStats = { candidates: number; enriched: number; errors: number };

export async function runEnrichJob(now: number): Promise<EnrichJobStats> {
  const stats: EnrichJobStats = { candidates: 0, enriched: 0, errors: 0 };
  if (!aiEnabled() || !enrichEnabled()) return stats;
  const ids = staleContactIds(now);
  stats.candidates = ids.length;
  for (const id of ids) {
    const result = await enrichContact(id, now);
    if (result.ok) stats.enriched++;
    else {
      stats.errors++;
      console.error(`[rolo-enrich] contact ${id}:`, result.error);
      // A contact with nothing to summarise stays stale forever otherwise;
      // stamp an empty card so the job moves on, and the profile shows nothing.
      if (result.error.startsWith("Nothing to summarise")) {
        upsertAnnotation("contact_profile", id, null, aiConfig()?.model ?? "unknown", null);
      }
    }
  }
  return stats;
}

/** Cards for a set of contacts (Ask timelines, digest picks). */
export function profileCards(contactIds: number[]): Map<number, ProfileCard> {
  const out = new Map<number, ProfileCard>();
  if (contactIds.length === 0) return out;
  const rows = db
    .select()
    .from(aiAnnotations)
    .where(and(eq(aiAnnotations.kind, "contact_profile"), inArray(aiAnnotations.subjectId, contactIds)))
    .all();
  for (const r of rows) {
    try {
      const card = JSON.parse(r.payloadJson) as ProfileCard | null;
      if (card) out.set(r.subjectId, card);
    } catch {
      // unreadable → absent
    }
  }
  return out;
}
