import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { aiSuggestions, contacts, contactTags, tags } from "@/db/schema";
import { cleanLine, cleanName } from "@/lib/agent/writes";
import { TAG_NAME_MAX } from "@/server/membership-core";

// Tags an agent proposes for people, with its evidence (SPEC §17). They
// join the queue the in-app tagger already uses (`ai_suggestions`, SPEC
// §11) and nothing is tagged until the owner approves each one there.
// Never export these from a "use server" file.

export const TAG_EVIDENCE_MAX = 300;

export type TagProposal = { contactId: number; tag: string; evidence: string };

export type TagSuggestionResult = {
  created: { id: number; contactId: number; tag: string }[];
  /** Left out, and why: already tagged, already waiting, no such person. */
  skipped: { contactId: number; tag: string; why: string }[];
};

type Payload = { tagName: string; isNewTag: boolean; confidence: number; rationale: string; source?: string };

export function suggestTags(proposals: TagProposal[], now = Date.now()): TagSuggestionResult {
  const result: TagSuggestionResult = { created: [], skipped: [] };
  const allTags = db.select({ id: tags.id, name: tags.name }).from(tags).all();
  const ids = [...new Set(proposals.map((p) => p.contactId))];
  const known = new Set(ids.length ? db.select({ id: contacts.id }).from(contacts).where(inArray(contacts.id, ids)).all().map((c) => c.id) : []);
  const waiting = new Set<string>();
  for (const row of db.select({ contactId: aiSuggestions.contactId, payloadJson: aiSuggestions.payloadJson }).from(aiSuggestions).where(and(eq(aiSuggestions.kind, "tag"), eq(aiSuggestions.status, "pending"))).all()) {
    try {
      waiting.add(`${row.contactId}|${String((JSON.parse(row.payloadJson) as Payload).tagName).toLowerCase()}`);
    } catch {
      // An unreadable row blocks nothing.
    }
  }
  for (const p of proposals) {
    const name = cleanName(p.tag, TAG_NAME_MAX);
    const evidence = cleanLine(p.evidence, TAG_EVIDENCE_MAX);
    const skip = (why: string) => result.skipped.push({ contactId: p.contactId, tag: name || p.tag.slice(0, TAG_NAME_MAX), why });
    if (!name) {
      skip("a tag needs a name");
      continue;
    }
    if (!evidence) {
      skip("a suggestion needs its evidence");
      continue;
    }
    if (!known.has(p.contactId)) {
      skip("no such contact");
      continue;
    }
    const existing = allTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (existing && db.select({ c: contactTags.contactId }).from(contactTags).where(and(eq(contactTags.contactId, p.contactId), eq(contactTags.tagId, existing.id))).get()) {
      skip("already has this tag");
      continue;
    }
    const key = `${p.contactId}|${name.toLowerCase()}`;
    if (waiting.has(key)) {
      skip("already waiting for the owner");
      continue;
    }
    waiting.add(key);
    const payload: Payload = { tagName: existing?.name ?? name, isNewTag: !existing, confidence: 1, rationale: evidence, source: "agent" };
    const row = db
      .insert(aiSuggestions)
      .values({ kind: "tag", contactId: p.contactId, payloadJson: JSON.stringify(payload), aiCallId: null, status: "pending", createdAt: now })
      .returning({ id: aiSuggestions.id })
      .get();
    result.created.push({ id: row.id, contactId: p.contactId, tag: payload.tagName });
  }
  return result;
}

/** Withdraw suggestions the owner has not answered. A row id is not an identity: the creation time must match too. */
export function withdrawTagSuggestions(ids: number[], createdAt: number): number {
  if (ids.length === 0) return 0;
  return db
    .delete(aiSuggestions)
    .where(and(inArray(aiSuggestions.id, ids), eq(aiSuggestions.status, "pending"), eq(aiSuggestions.createdAt, createdAt), eq(aiSuggestions.kind, "tag")))
    .run().changes;
}
