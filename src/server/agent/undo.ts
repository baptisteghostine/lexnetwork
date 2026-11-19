import "server-only";

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  agentCalls,
  contactChanges,
  contactEmails,
  contactFieldSources,
  contacts,
  contactSocials,
  contactTags,
  groups,
  interactions,
  notes,
  reminders,
  tags,
} from "@/db/schema";
import { recomputeContact } from "@/lib/cadence/recompute";
import { normalizeForCompare } from "@/lib/imports/planner";
import { SCALAR_FIELDS, type ScalarField } from "@/lib/imports/types";
import { pruneOrphanAnnotations } from "@/server/ai-annotations";
import { parseWrites, type WriteRecord } from "@/server/agent/ledger";
import { applyScalarWrite, syncDisplayName, upsertProvenance } from "@/server/import-engine";
import { setGroupMembership, setTagMembership } from "@/server/membership-core";
import { mentionedContactIds } from "@/server/note-sync";

// Taking back what an agent wrote (SPEC §14, Phase 15).
//
// Undo reverses exactly the rows one call recorded in its ledger entry,
// and is careful about the one thing that can go wrong with it: the owner
// may have built on what the agent wrote. So it never removes something
// the owner has since changed or added to — an edited note stays, a field
// the owner retyped stays, a contact that has gained other records is not
// deleted. Those are reported as left in place, or (for a contact) the
// whole undo is refused with the reason.

export type UndoResult =
  | {
      ok: true;
      tool: string;
      summary: string | null;
      contactId: number | null;
      /** What was taken back, in words. */
      reversed: string[];
      /** What was left because it had changed since, and why. */
      skipped: string[];
    }
  | { ok: false; error: string };

class UndoBlocked extends Error {}

const CONTACT_COLUMN: Record<Exclude<ScalarField, "birthday">, "firstName" | "lastName" | "title" | "company" | "location" | "bio"> = {
  first_name: "firstName",
  last_name: "lastName",
  title: "title",
  company: "company",
  location: "location",
  bio: "bio",
};

function isScalarField(field: string): field is Exclude<ScalarField, "birthday"> {
  return field !== "birthday" && (SCALAR_FIELDS as readonly string[]).includes(field);
}

function reverse(write: WriteRecord, all: WriteRecord[], now: number, out: { reversed: string[]; skipped: string[] }): void {
  switch (write.table) {
    case "interactions": {
      const row = db.select({ id: interactions.id, contactId: interactions.contactId }).from(interactions).where(eq(interactions.id, write.id)).get();
      if (!row) {
        out.skipped.push("the interaction was already gone");
        return;
      }
      db.delete(interactions).where(eq(interactions.id, write.id)).run();
      recomputeContact(row.contactId);
      out.reversed.push("removed the interaction");
      return;
    }
    case "notes": {
      const row = db.select().from(notes).where(eq(notes.id, write.id)).get();
      if (!row) {
        out.skipped.push("the note was already gone");
        return;
      }
      if (write.stamp !== undefined && row.updatedAt !== write.stamp) {
        out.skipped.push("the note was edited after it was written, so it was kept");
        return;
      }
      const touched = [row.contactId, ...mentionedContactIds(write.id)];
      db.delete(notes).where(eq(notes.id, write.id)).run();
      for (const id of new Set(touched)) if (id !== null) recomputeContact(id);
      out.reversed.push("removed the note");
      return;
    }
    case "reminders": {
      const row = db.select().from(reminders).where(eq(reminders.id, write.id)).get();
      if (!row) {
        out.skipped.push("the reminder was already gone");
        return;
      }
      if (write.op === "insert") {
        if (write.stamp !== undefined && row.updatedAt !== write.stamp) {
          out.skipped.push("the reminder was changed after it was created, so it was kept");
          return;
        }
        db.delete(reminders).where(eq(reminders.id, write.id)).run();
        out.reversed.push("removed the reminder");
        return;
      }
      if (row.completedAt === null) {
        out.skipped.push("the reminder was already open again");
        return;
      }
      db.update(reminders).set({ completedAt: null, updatedAt: now }).where(eq(reminders.id, write.id)).run();
      if (write.nextOccurrenceId !== null) {
        // The next occurrence that completing it materialized: only while untouched.
        db.delete(reminders)
          .where(
            and(
              eq(reminders.id, write.nextOccurrenceId),
              sql`${reminders.completedAt} IS NULL AND ${reminders.firedAt} IS NULL`
            )
          )
          .run();
      }
      out.reversed.push("reopened the reminder");
      return;
    }
    case "contacts": {
      const row = db.select().from(contacts).where(eq(contacts.id, write.id)).get();
      if (!row) {
        out.skipped.push("the contact was already gone");
        return;
      }
      if (write.op === "insert") {
        // Everything this same call wrote about the contact goes with it;
        // anything else attached to them means they are no longer just
        // "what the agent added".
        const own = (table: "interactions" | "notes"): number[] =>
          all.flatMap((w) => (w.table === table && w.op === "insert" ? [w.id] : []));
        const countOther = (table: typeof interactions | typeof notes, ids: number[]) =>
          db
            .select({ n: sql<number>`count(*)` })
            .from(table)
            .where(
              ids.length
                ? and(eq(table.contactId, write.id), notInArray(table.id, ids))
                : eq(table.contactId, write.id)
            )
            .get()?.n ?? 0;
        const others =
          countOther(interactions, own("interactions")) +
          countOther(notes, own("notes")) +
          (db.select({ n: sql<number>`count(*)` }).from(reminders).where(eq(reminders.contactId, write.id)).get()?.n ?? 0);
        if (others > 0) {
          throw new UndoBlocked(
            `${row.displayName} now has other notes, interactions or reminders, so removing the contact would take those too. Undo those actions first, or delete the contact from its page in Rolo.`
          );
        }
        const ownerTouched = db
          .select({ n: sql<number>`count(*)` })
          .from(contactFieldSources)
          .where(and(eq(contactFieldSources.contactId, write.id), eq(contactFieldSources.source, "user")))
          .get()?.n;
        if (ownerTouched) {
          throw new UndoBlocked(
            `${row.displayName} has been edited by the owner since being added, so the contact was kept. Delete it from its page in Rolo if it should go.`
          );
        }
        db.delete(contacts).where(eq(contacts.id, write.id)).run();
        pruneOrphanAnnotations("contact_profile");
        pruneOrphanAnnotations("change_triage");
        out.reversed.push(`removed the contact ${row.displayName}`);
        return;
      }
      for (const f of write.fields) {
        if (!isScalarField(f.field)) continue;
        const current = row[CONTACT_COLUMN[f.field]];
        if (current === null || normalizeForCompare(f.field, current) !== normalizeForCompare(f.field, f.after)) {
          out.skipped.push(`${f.field.replace("_", " ")} has changed since, so it was left as it is`);
          continue;
        }
        applyScalarWrite(write.id, f.field, f.before, undefined, now);
        if (f.beforeSource) {
          upsertProvenance(write.id, f.field, f.beforeSource, null, now);
        } else {
          db.delete(contactFieldSources)
            .where(and(eq(contactFieldSources.contactId, write.id), eq(contactFieldSources.field, f.field)))
            .run();
        }
        out.reversed.push(`restored ${f.field.replace("_", " ")}`);
      }
      if (write.emailIds.length > 0) {
        const removed = db
          .delete(contactEmails)
          .where(and(inArray(contactEmails.id, write.emailIds), eq(contactEmails.source, "agent")))
          .run().changes;
        if (removed > 0) out.reversed.push(removed === 1 ? "removed the email address" : `removed ${removed} email addresses`);
      }
      if (write.socialIds.length > 0) {
        const removed = db
          .delete(contactSocials)
          .where(and(inArray(contactSocials.id, write.socialIds), eq(contactSocials.source, "agent")))
          .run().changes;
        if (removed > 0) out.reversed.push("removed the link");
      }
      if (write.changeIds.length > 0) {
        db.delete(contactChanges).where(inArray(contactChanges.id, write.changeIds)).run();
        pruneOrphanAnnotations("change_triage");
      }
      syncDisplayName(write.id);
      return;
    }
    case "tags": {
      const used = db.select({ n: sql<number>`count(*)` }).from(contactTags).where(eq(contactTags.tagId, write.id)).get()?.n ?? 0;
      if (used > 0) {
        out.skipped.push("the new tag is in use on other contacts, so it was kept");
        return;
      }
      const removed = db.delete(tags).where(eq(tags.id, write.id)).run().changes;
      if (removed > 0) out.reversed.push("removed the new tag");
      return;
    }
    case "contact_tags": {
      if (!db.select({ id: tags.id }).from(tags).where(eq(tags.id, write.tagId)).get()) {
        out.skipped.push("the tag no longer exists");
        return;
      }
      const res = setTagMembership(write.contactIds, write.tagId, write.op === "remove");
      if (res.ok) {
        out.reversed.push(
          `${write.op === "add" ? "untagged" : "re-tagged"} ${res.changedContactIds.length} contact${res.changedContactIds.length === 1 ? "" : "s"}`
        );
      }
      return;
    }
    case "group_members": {
      if (!db.select({ id: groups.id }).from(groups).where(eq(groups.id, write.groupId)).get()) {
        out.skipped.push("the group no longer exists");
        return;
      }
      const res = setGroupMembership(write.contactIds, write.groupId, write.op === "remove");
      if (res.ok) {
        out.reversed.push(
          `${write.op === "add" ? "removed" : "put back"} ${res.changedContactIds.length} group member${res.changedContactIds.length === 1 ? "" : "s"}`
        );
      }
      return;
    }
  }
}

/**
 * Reverse one ledgered write call. All or nothing: if any part must be
 * refused (a contact that has gained other records), nothing is undone.
 */
export function undoAgentCall(callId: number, now = Date.now()): UndoResult {
  const call = db.select().from(agentCalls).where(eq(agentCalls.id, callId)).get();
  if (!call) return { ok: false, error: `There is no action with id ${callId}.` };
  if (call.tool === "undo_agent_action") return { ok: false, error: "An undo cannot itself be undone. Make the change again instead." };
  if (call.status === "queued") {
    return { ok: false, error: "That action is still waiting for the owner's approval; it has not changed anything." };
  }
  if (call.status !== "success") return { ok: false, error: "That action did not change anything." };
  if (call.undoneAt !== null) return { ok: false, error: "That action has already been undone." };
  const writes = parseWrites(call.writesJson);
  if (writes.length === 0) return { ok: false, error: "That action did not change anything, so there is nothing to undo." };

  const out = { reversed: [] as string[], skipped: [] as string[] };
  try {
    db.transaction(() => {
      // Last written, first reversed: a tag's memberships before the tag,
      // a contact's records before the contact.
      for (const write of [...writes].reverse()) reverse(write, writes, now, out);
      db.update(agentCalls).set({ undoneAt: now }).where(eq(agentCalls.id, callId)).run();
    });
  } catch (err) {
    if (err instanceof UndoBlocked) return { ok: false, error: err.message };
    throw err;
  }
  return {
    ok: true,
    tool: call.tool,
    summary: call.summary,
    contactId: call.contactId,
    reversed: out.reversed,
    skipped: out.skipped,
  };
}
