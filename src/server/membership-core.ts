import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts, contactTags, groupMembers, groups, tags } from "@/db/schema";

// Tag and group membership, without a session (SPEC §14, Phase 13). The
// contacts-list bulk bar goes through here behind the cookie; the agent
// connector will behind its token. Each function reports exactly which
// contacts it changed, so a caller can record an undo that reverses only
// that — a contact that already had the tag is not "untagged" by an undo.
//
// Never export these from a "use server" file.

export const TAG_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#78716c",
] as const;

export const TAG_NAME_MAX = 50;
/** One call's worth of contacts — the bulk bar's cap. */
export const MEMBERSHIP_BATCH_MAX = 1000;

export type FindOrCreateTagResult =
  | { ok: true; tagId: number; name: string; created: boolean }
  | { ok: false; error: string };

/**
 * The tag with this name (case-insensitive — "Investor" finds "investor",
 * which is what keeps an agent from growing synonyms by capitalisation),
 * or a new one. New tags take the next palette colour.
 */
export function findOrCreateTag(rawName: string): FindOrCreateTagResult {
  const name = rawName.trim().replace(/\s+/g, " ");
  if (!name || name.length > TAG_NAME_MAX) {
    return { ok: false, error: `A tag needs a name of at most ${TAG_NAME_MAX} characters.` };
  }
  const existing = db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(sql`lower(${tags.name}) = lower(${name})`)
    .get();
  if (existing) return { ok: true, tagId: existing.id, name: existing.name, created: false };
  const count = db.select({ n: sql<number>`count(*)` }).from(tags).get()?.n ?? 0;
  const row = db
    .insert(tags)
    .values({ name, color: TAG_COLORS[count % TAG_COLORS.length], createdAt: Date.now() })
    .returning({ id: tags.id })
    .get();
  return { ok: true, tagId: row.id, name, created: true };
}

export type MembershipResult =
  | {
      ok: true;
      /** Contacts whose membership this call actually flipped. */
      changedContactIds: number[];
      /** Ids that were asked for but are not contacts. */
      unknownContactIds: number[];
    }
  | { ok: false; error: string };

function splitKnown(contactIds: number[]): { known: number[]; unknown: number[] } {
  const ids = [...new Set(contactIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return { known: [], unknown: [] };
  const found = new Set(
    db
      .select({ id: contacts.id })
      .from(contacts)
      .where(inArray(contacts.id, ids))
      .all()
      .map((c) => c.id)
  );
  return { known: ids.filter((id) => found.has(id)), unknown: ids.filter((id) => !found.has(id)) };
}

/** Put the tag on these contacts (`present`) or take it off them. */
export function setTagMembership(
  contactIds: number[],
  tagId: number,
  present: boolean
): MembershipResult {
  if (contactIds.length > MEMBERSHIP_BATCH_MAX) {
    return { ok: false, error: `At most ${MEMBERSHIP_BATCH_MAX} contacts per call.` };
  }
  if (!db.select({ id: tags.id }).from(tags).where(eq(tags.id, tagId)).get()) {
    return { ok: false, error: "Tag not found." };
  }
  const { known, unknown } = splitKnown(contactIds);
  if (known.length === 0) return { ok: true, changedContactIds: [], unknownContactIds: unknown };
  const has = new Set(
    db
      .select({ contactId: contactTags.contactId })
      .from(contactTags)
      .where(and(eq(contactTags.tagId, tagId), inArray(contactTags.contactId, known)))
      .all()
      .map((r) => r.contactId)
  );
  const changed = known.filter((id) => has.has(id) !== present);
  const now = Date.now();
  db.transaction(() => {
    for (const contactId of changed) {
      if (present) {
        db.insert(contactTags).values({ contactId, tagId, createdAt: now }).onConflictDoNothing().run();
      } else {
        db.delete(contactTags)
          .where(and(eq(contactTags.contactId, contactId), eq(contactTags.tagId, tagId)))
          .run();
      }
    }
  });
  return { ok: true, changedContactIds: changed, unknownContactIds: unknown };
}

/** Add these contacts to the group (`present`) or remove them from it. */
export function setGroupMembership(
  contactIds: number[],
  groupId: number,
  present: boolean
): MembershipResult {
  if (contactIds.length > MEMBERSHIP_BATCH_MAX) {
    return { ok: false, error: `At most ${MEMBERSHIP_BATCH_MAX} contacts per call.` };
  }
  if (!db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).get()) {
    return { ok: false, error: "Group not found." };
  }
  const { known, unknown } = splitKnown(contactIds);
  if (known.length === 0) return { ok: true, changedContactIds: [], unknownContactIds: unknown };
  const has = new Set(
    db
      .select({ contactId: groupMembers.contactId })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), inArray(groupMembers.contactId, known)))
      .all()
      .map((r) => r.contactId)
  );
  const changed = known.filter((id) => has.has(id) !== present);
  const now = Date.now();
  db.transaction(() => {
    for (const contactId of changed) {
      if (present) {
        db.insert(groupMembers).values({ contactId, groupId, createdAt: now }).onConflictDoNothing().run();
      } else {
        db.delete(groupMembers)
          .where(and(eq(groupMembers.contactId, contactId), eq(groupMembers.groupId, groupId)))
          .run();
      }
    }
  });
  return { ok: true, changedContactIds: changed, unknownContactIds: unknown };
}
