import "server-only";

import { and, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  agentCalls,
  contactChanges,
  contactEmails,
  contactFieldSources,
  contactPhones,
  contactRelationships,
  contacts,
  contactSocials,
  contactTags,
  customFieldValues,
  education,
  groupMembers,
  groups,
  interactions,
  noteMentions,
  notes,
  reminders,
  tags,
  workHistory,
} from "@/db/schema";
import { recomputeContact } from "@/lib/cadence/recompute";
import { SCALAR_FIELDS, type ScalarField } from "@/lib/imports/types";
import { pruneOrphanAnnotations } from "@/server/ai-annotations";
import { noteSignature, parseWrites, reminderSignature, type WriteRecord } from "@/server/agent/ledger";
import { restoreCadence } from "@/server/cadence-core";
import { applyScalarWrite, syncDisplayName, upsertProvenance } from "@/server/import-engine";
import { unconfirmGuess, undoBounce } from "@/server/email-guess-core";
import { restoreFirmEmailFormat, restoreFirmTier } from "@/server/firms-core";
import { setGroupMembership, setTagMembership } from "@/server/membership-core";
import { mentionedContactIds } from "@/server/note-sync";
import { undoCampaignSave, undoDraftSave, undoVoiceGuide } from "@/server/outreach-core";
import { withdrawTagSuggestions } from "@/server/tag-suggestion-core";
import { undoWhatsAppSummary } from "@/server/whatsapp-core";

// Taking back what an agent wrote (SPEC §14, Phase 15).
//
// Undo reverses exactly the rows one call recorded in its ledger entry,
// and is careful about the two things that can go wrong with it.
//
// The row may not be the row any more. SQLite gives a freed id to the
// next insert, so after the owner deletes what the agent wrote, something
// unrelated can sit under the same number. Every reversal first checks
// the row is the one that was written — its contact, key, name or
// creation time — and skips it otherwise.
//
// The owner may have built on what the agent wrote. So undo never removes
// something the owner has since changed or added to: an edited note
// stays, a field the owner retyped stays, a contact that has gained
// anything at all is not deleted. Those are reported as left in place, or
// (for a contact) the whole undo is refused with the reason.

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

function count(query: { get: () => { n: number } | undefined }): number {
  return query.get()?.n ?? 0;
}

const N = sql<number>`count(*)`;

/** Memberships written at `at`: not ones the owner removed and added again later. */
const WRITTEN_WINDOW_BEFORE_MS = 30_000;
const WRITTEN_WINDOW_AFTER_MS = 2_000;

/**
 * Why a contact an agent added can no longer simply be removed: anything
 * at all that is attached to them beyond what adding them wrote. Null
 * when they are still exactly that.
 */
function whyContactMustStay(contactId: number, callId: number): string | null {
  const c = db.select().from(contacts).where(eq(contacts.id, contactId)).get();
  if (!c) return null;
  const attached =
    count(db.select({ n: N }).from(interactions).where(eq(interactions.contactId, contactId))) +
    count(db.select({ n: N }).from(notes).where(eq(notes.contactId, contactId))) +
    count(db.select({ n: N }).from(reminders).where(eq(reminders.contactId, contactId))) +
    count(db.select({ n: N }).from(noteMentions).where(eq(noteMentions.contactId, contactId)));
  if (attached > 0) return "now has notes, interactions or reminders";
  const organised =
    count(db.select({ n: N }).from(contactTags).where(eq(contactTags.contactId, contactId))) +
    count(db.select({ n: N }).from(groupMembers).where(eq(groupMembers.contactId, contactId))) +
    count(
      db
        .select({ n: N })
        .from(contactRelationships)
        .where(or(eq(contactRelationships.contactAId, contactId), eq(contactRelationships.contactBId, contactId)))
    ) +
    count(db.select({ n: N }).from(customFieldValues).where(eq(customFieldValues.contactId, contactId)));
  if (organised > 0) return "has since been tagged, grouped, linked to someone or given custom fields";
  const details =
    count(db.select({ n: N }).from(contactPhones).where(eq(contactPhones.contactId, contactId))) +
    count(db.select({ n: N }).from(contactEmails).where(and(eq(contactEmails.contactId, contactId), ne(contactEmails.source, "agent")))) +
    count(db.select({ n: N }).from(contactSocials).where(and(eq(contactSocials.contactId, contactId), ne(contactSocials.source, "agent")))) +
    count(db.select({ n: N }).from(contactFieldSources).where(and(eq(contactFieldSources.contactId, contactId), ne(contactFieldSources.source, "agent")))) +
    count(db.select({ n: N }).from(workHistory).where(eq(workHistory.contactId, contactId))) +
    count(db.select({ n: N }).from(education).where(eq(education.contactId, contactId)));
  if (details > 0) return "has details that did not come from Claude";
  // Something a later agent call wrote about them: undo that first.
  const later = count(
    db
      .select({ n: N })
      .from(agentCalls)
      .where(
        and(
          eq(agentCalls.contactId, contactId),
          ne(agentCalls.id, callId),
          eq(agentCalls.status, "success"),
          sql`${agentCalls.undoneAt} IS NULL`,
          sql`${agentCalls.writesJson} IS NOT NULL AND ${agentCalls.writesJson} <> '[]'`
        )
      )
  );
  if (later > 0) return "has later changes by Claude that have not been undone";
  if (
    c.cadenceDays !== null ||
    c.cadenceReviewedAt !== null ||
    c.starred ||
    c.snoozedUntil !== null ||
    c.archivedAt !== null ||
    c.photoPath !== null ||
    c.descriptionMd ||
    c.birthdayMonth !== null
  ) {
    return "has been set up by you since being added";
  }
  return null;
}

function reverse(
  write: WriteRecord,
  callId: number,
  now: number,
  out: { reversed: string[]; skipped: string[] }
): void {
  switch (write.table) {
    case "interactions": {
      const row = db.select().from(interactions).where(eq(interactions.id, write.id)).get();
      if (!row || row.contactId !== write.contactId || row.source !== "agent" || row.sourceKey !== write.key) {
        out.skipped.push("the interaction was already gone");
        return;
      }
      db.delete(interactions).where(eq(interactions.id, write.id)).run();
      // Logging a touch cleared the contact's snooze; taking the touch
      // back puts it back, unless it has lapsed or been replaced.
      if (typeof write.snoozedBefore === "number" && write.snoozedBefore > now) {
        db.update(contacts)
          .set({ snoozedUntil: write.snoozedBefore })
          .where(and(eq(contacts.id, row.contactId), sql`${contacts.snoozedUntil} IS NULL`))
          .run();
      }
      recomputeContact(row.contactId);
      out.reversed.push("removed the interaction");
      return;
    }
    case "notes": {
      const current = noteSignature(write.id);
      if (!current || current.createdAt !== write.createdAt) {
        out.skipped.push("the note was already gone");
        return;
      }
      if (current.sig !== write.sig) {
        out.skipped.push("the note was edited after it was written, so it was kept");
        return;
      }
      const touched = [write.contactId, ...mentionedContactIds(write.id)];
      db.delete(notes).where(eq(notes.id, write.id)).run();
      for (const id of new Set(touched)) if (id !== null) recomputeContact(id);
      out.reversed.push("removed the note");
      return;
    }
    case "reminders": {
      const row = db.select().from(reminders).where(eq(reminders.id, write.id)).get();
      if (write.op === "insert") {
        const current = reminderSignature(write.id);
        if (!row || !current || current.createdAt !== write.createdAt) {
          out.skipped.push("the reminder was already gone");
          return;
        }
        if (current.sig !== write.sig) {
          out.skipped.push("the reminder was changed after it was created, so it was kept");
          return;
        }
        db.delete(reminders).where(eq(reminders.id, write.id)).run();
        out.reversed.push("removed the reminder");
        return;
      }
      if (!row || row.completedAt !== write.completedAt) {
        out.skipped.push(row && row.completedAt === null ? "the reminder was already open again" : "the reminder was already gone");
        return;
      }
      db.update(reminders).set({ completedAt: null, updatedAt: now }).where(eq(reminders.id, write.id)).run();
      // The next occurrence completing it materialized: only while it is
      // still exactly that — not snoozed, renamed, fired or done.
      if (write.nextOccurrenceId !== null && write.nextSig !== undefined) {
        const next = db.select().from(reminders).where(eq(reminders.id, write.nextOccurrenceId)).get();
        if (next && next.firedAt === null && reminderSignature(next.id)?.sig === write.nextSig) {
          db.delete(reminders).where(eq(reminders.id, next.id)).run();
        }
      }
      out.reversed.push("reopened the reminder");
      return;
    }
    case "contacts": {
      const row = db.select().from(contacts).where(eq(contacts.id, write.id)).get();
      if (!row || row.createdAt !== write.createdAt) {
        out.skipped.push("the contact was already gone");
        return;
      }
      if (write.op === "insert") {
        const reason = whyContactMustStay(write.id, callId);
        if (reason) {
          throw new UndoBlocked(
            `${row.displayName} ${reason}, so removing the contact would take that too. Nothing was undone. Take those back first, or delete the contact from its page in Rolo.`
          );
        }
        db.delete(contacts).where(eq(contacts.id, write.id)).run();
        pruneOrphanAnnotations("contact_profile");
        pruneOrphanAnnotations("change_triage");
        out.reversed.push(`removed the contact ${row.displayName}`);
        return;
      }
      if (write.op === "cadence") {
        // Still the rhythm this call set, set when it set it: a cadence
        // the owner has since picked on the board is theirs.
        if (
          row.cadenceDays !== write.after.cadenceDays ||
          row.cadenceAssignedAt !== write.after.cadenceAssignedAt ||
          row.cadenceReviewedAt !== write.after.cadenceReviewedAt
        ) {
          out.skipped.push(`${row.displayName}'s keep-in-touch rhythm has been changed since, so it was left as it is`);
          return;
        }
        restoreCadence(write.id, write.before, now);
        out.reversed.push(`put ${row.displayName}'s keep-in-touch rhythm back`);
        return;
      }
      const sources = new Map(
        db
          .select({ field: contactFieldSources.field, source: contactFieldSources.source })
          .from(contactFieldSources)
          .where(eq(contactFieldSources.contactId, write.id))
          .all()
          .map((r) => [r.field, r.source])
      );
      for (const f of write.fields) {
        if (!isScalarField(f.field)) continue;
        // Still exactly what the agent put there, and still the agent's:
        // a value the owner retyped — even to the same words in another
        // case — is the owner's.
        if (row[CONTACT_COLUMN[f.field]] !== f.after || sources.get(f.field) !== "agent") {
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
      if (write.emails.length > 0) {
        const removed = db
          .delete(contactEmails)
          .where(
            and(
              eq(contactEmails.contactId, write.id),
              inArray(contactEmails.emailNormalized, write.emails),
              eq(contactEmails.source, "agent")
            )
          )
          .run().changes;
        if (removed > 0) out.reversed.push(removed === 1 ? "removed the email address" : `removed ${removed} email addresses`);
      }
      if (write.socialUrls.length > 0) {
        const removed = db
          .delete(contactSocials)
          .where(
            and(
              eq(contactSocials.contactId, write.id),
              inArray(contactSocials.url, write.socialUrls),
              eq(contactSocials.source, "agent")
            )
          )
          .run().changes;
        if (removed > 0) out.reversed.push("removed the link");
      }
      if (write.changeIds.length > 0) {
        db.delete(contactChanges)
          .where(
            and(
              inArray(contactChanges.id, write.changeIds),
              eq(contactChanges.contactId, write.id),
              eq(contactChanges.source, "agent")
            )
          )
          .run();
        pruneOrphanAnnotations("change_triage");
      }
      syncDisplayName(write.id);
      return;
    }
    case "outreach_drafts": {
      const res = undoDraftSave(write);
      if (res.ok) out.reversed.push(res.what);
      else out.skipped.push(res.error);
      return;
    }
    case "campaigns": {
      const res = undoCampaignSave(write.groupId, write.marker, write);
      if (res.ok) out.reversed.push(res.what);
      else out.skipped.push(res.error);
      return;
    }
    case "firms": {
      const res = write.op === "tier" ? restoreFirmTier(write.key, write.before, write.after, now) : restoreFirmEmailFormat(write.key, write.before, write.after, now);
      if (res.ok) out.reversed.push(write.op === "tier" ? `put ${write.name}'s tier back` : `put ${write.name}'s address format back`);
      else out.skipped.push(res.error);
      return;
    }
    case "email_guesses": {
      if (write.op === "confirm") {
        const res = unconfirmGuess(write.contactId, write.email, write.previous, now);
        if (res.ok) out.reversed.push("marked the address as unconfirmed again");
        else out.skipped.push(res.error);
        return;
      }
      const res = undoBounce(write.record, now);
      out.reversed.push(...res.reversed);
      out.skipped.push(...res.skipped);
      return;
    }
    case "ai_suggestions": {
      const n = withdrawTagSuggestions(write.ids, write.createdAt);
      if (n > 0) out.reversed.push(`withdrew ${n} tag suggestion${n === 1 ? "" : "s"}`);
      if (n < write.ids.length) out.skipped.push(`${write.ids.length - n} tag suggestion${write.ids.length - n === 1 ? " was" : "s were"} already answered`);
      return;
    }
    case "settings": {
      const res = undoVoiceGuide(write.marker, now);
      if (res.ok) out.reversed.push("put the previous voice guide back");
      else out.skipped.push(res.error);
      return;
    }
    case "whatsapp_links": {
      const res = undoWhatsAppSummary(write.id, write.updatedAt, now);
      if (res.ok) out.reversed.push("put the previous WhatsApp summary back");
      else out.skipped.push(res.error);
      return;
    }
    case "tags": {
      const row = db.select().from(tags).where(eq(tags.id, write.id)).get();
      if (!row || row.name !== write.name) {
        out.skipped.push("the new tag was already gone");
        return;
      }
      if (count(db.select({ n: N }).from(contactTags).where(eq(contactTags.tagId, write.id))) > 0) {
        out.skipped.push("the new tag is in use on other contacts, so it was kept");
        return;
      }
      db.delete(tags).where(eq(tags.id, write.id)).run();
      out.reversed.push("removed the new tag");
      return;
    }
    case "contact_tags": {
      const tag = db.select().from(tags).where(eq(tags.id, write.tagId)).get();
      if (!tag || tag.name !== write.tagName) {
        out.skipped.push("the tag no longer exists");
        return;
      }
      // Taking a tag back off: only memberships written by this call.
      const ids =
        write.op === "add"
          ? db
              .select({ id: contactTags.contactId })
              .from(contactTags)
              .where(
                and(
                  eq(contactTags.tagId, write.tagId),
                  inArray(contactTags.contactId, write.contactIds),
                  gte(contactTags.createdAt, write.at - WRITTEN_WINDOW_BEFORE_MS),
                  lte(contactTags.createdAt, write.at + WRITTEN_WINDOW_AFTER_MS)
                )
              )
              .all()
              .map((r) => r.id)
          : write.contactIds;
      const res = ids.length ? setTagMembership(ids, write.tagId, write.op === "remove") : null;
      const n = res?.ok ? res.changedContactIds.length : 0;
      if (n > 0) out.reversed.push(`${write.op === "add" ? "untagged" : "re-tagged"} ${n} contact${n === 1 ? "" : "s"}`);
      else out.skipped.push("the tagging had already been changed");
      return;
    }
    case "group_members": {
      const group = db.select().from(groups).where(eq(groups.id, write.groupId)).get();
      if (!group || group.name !== write.groupName) {
        out.skipped.push("the group no longer exists");
        return;
      }
      const ids =
        write.op === "add"
          ? db
              .select({ id: groupMembers.contactId })
              .from(groupMembers)
              .where(
                and(
                  eq(groupMembers.groupId, write.groupId),
                  inArray(groupMembers.contactId, write.contactIds),
                  gte(groupMembers.createdAt, write.at - WRITTEN_WINDOW_BEFORE_MS),
                  lte(groupMembers.createdAt, write.at + WRITTEN_WINDOW_AFTER_MS)
                )
              )
              .all()
              .map((r) => r.id)
          : write.contactIds;
      const res = ids.length ? setGroupMembership(ids, write.groupId, write.op === "remove") : null;
      const n = res?.ok ? res.changedContactIds.length : 0;
      if (n > 0) out.reversed.push(`${write.op === "add" ? "removed" : "put back"} ${n} group member${n === 1 ? "" : "s"}`);
      else out.skipped.push("the group membership had already been changed");
      return;
    }
  }
}

class NothingToUndo extends Error {}

/**
 * Reverse one ledgered write call. All or nothing: if any part must be
 * refused (a contact that has gained other records), nothing is undone.
 * And if every part turns out to be the owner's now, the call is not
 * marked undone — nothing was.
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
      for (const write of [...writes].reverse()) reverse(write, callId, now, out);
      if (out.reversed.length === 0) throw new NothingToUndo();
      db.update(agentCalls).set({ undoneAt: now }).where(eq(agentCalls.id, callId)).run();
    });
  } catch (err) {
    if (err instanceof UndoBlocked) return { ok: false, error: err.message };
    if (err instanceof NothingToUndo) {
      return { ok: false, error: `Nothing was undone: ${out.skipped.join("; ")}.` };
    }
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
