import "server-only";

import { and, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";

import { db } from "@/db/client";
import {
  aiSuggestions,
  contactTags,
  contacts,
  tags,
  workHistory,
} from "@/db/schema";
import {
  buildAutoTagPrompt,
  buildAutoTagSystem,
  autoTagFormat,
  parseTagSuggestions,
  type AutoTagContact,
} from "@/lib/ai/prompts";
import { aiEnabled, callAi } from "@/server/ai-client";

// The ai_batch_tag job (SPEC §11): batched auto-tag calls whose output
// lands in the ai_suggestions queue — never applied directly. Runs
// through the scheduler so a big batch survives restarts and retries.

const BATCH_SIZE = 8;

export type AiBatchTagPayload = { contactIds: number[] };

export type AiBatchTagStats = {
  contactsProcessed: number;
  suggestionsAdded: number;
  batchErrors: number;
};

/** Contacts with no tags at all — the "all untagged" selection. */
export function untaggedContactIds(): number[] {
  const tagged = [
    ...new Set(
      db
        .select({ id: contactTags.contactId })
        .from(contactTags)
        .all()
        .map((r) => r.id)
    ),
  ];
  return db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      tagged.length > 0
        ? and(isNull(contacts.archivedAt), notInArray(contacts.id, tagged))
        : isNull(contacts.archivedAt)
    )
    .all()
    .map((r) => r.id);
}

function loadAutoTagContacts(ids: number[]): AutoTagContact[] {
  if (ids.length === 0) return [];
  const rows = db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      title: contacts.title,
      company: contacts.company,
      location: contacts.location,
      bio: contacts.bio,
    })
    .from(contacts)
    .where(inArray(contacts.id, ids))
    .all();
  const history = db
    .select({
      contactId: workHistory.contactId,
      company: workHistory.company,
    })
    .from(workHistory)
    .where(inArray(workHistory.contactId, ids))
    .orderBy(desc(workHistory.isCurrent))
    .all();
  const tagRows = db
    .select({
      contactId: contactTags.contactId,
      name: tags.name,
    })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(inArray(contactTags.contactId, ids))
    .all();

  const historyBy = new Map<number, string[]>();
  for (const h of history) {
    const list = historyBy.get(h.contactId) ?? [];
    if (!list.includes(h.company)) list.push(h.company);
    historyBy.set(h.contactId, list);
  }
  const tagsBy = new Map<number, string[]>();
  for (const t of tagRows) {
    const list = tagsBy.get(t.contactId) ?? [];
    list.push(t.name);
    tagsBy.set(t.contactId, list);
  }
  return rows.map((r) => ({
    ...r,
    workHistory: (historyBy.get(r.id) ?? []).slice(0, 6),
    existingTags: tagsBy.get(r.id) ?? [],
  }));
}

/** One batch job run. Each chunk is one logged model call. */
export async function runAiBatchTag(
  payloadJson: string | null
): Promise<AiBatchTagStats> {
  if (!aiEnabled()) {
    throw new Error("AI is not configured — the batch cannot run.");
  }
  let payload: AiBatchTagPayload;
  try {
    payload = JSON.parse(payloadJson ?? "") as AiBatchTagPayload;
  } catch {
    throw new Error("ai_batch_tag job has no valid payload.");
  }
  const ids = [...new Set(payload.contactIds)].filter(
    (n) => Number.isInteger(n) && n > 0
  );
  const allTags = db.select({ name: tags.name }).from(tags).all().map((t) => t.name);
  const system = buildAutoTagSystem(allTags);

  const stats: AiBatchTagStats = {
    contactsProcessed: 0,
    suggestionsAdded: 0,
    batchErrors: 0,
  };
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = loadAutoTagContacts(ids.slice(i, i + BATCH_SIZE));
    if (chunk.length === 0) continue;
    const result = await callAi({
      feature: "auto_tag",
      system,
      prompt: buildAutoTagPrompt(chunk),
      maxTokens: 2048,
      outputFormat: autoTagFormat(),
    });
    stats.contactsProcessed += chunk.length;
    if (!result.ok) {
      stats.batchErrors += 1;
      continue;
    }
    const suggestions = parseTagSuggestions(result.text, chunk, allTags);
    if (suggestions === null) {
      stats.batchErrors += 1;
      continue;
    }
    const now = Date.now();
    for (const s of suggestions) {
      db.insert(aiSuggestions)
        .values({
          kind: "tag",
          contactId: s.contactId,
          payloadJson: JSON.stringify({
            tagName: s.tagName,
            isNewTag: s.isNewTag,
            confidence: s.confidence,
            rationale: s.rationale,
          }),
          aiCallId: result.callId,
          status: "pending",
          createdAt: now,
        })
        .run();
      stats.suggestionsAdded += 1;
    }
  }
  if (stats.batchErrors > 0 && stats.suggestionsAdded === 0) {
    throw new Error(
      `Auto-tag failed: ${stats.batchErrors} batch call(s) errored with no suggestions produced.`
    );
  }
  return stats;
}
