import "server-only";

import { and, eq, gt, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import {
  agentCalls,
  contactChanges,
  contactEmails,
  contactFieldSources,
  contacts,
  contactSocials,
  groups,
  interactions,
  notes,
  reminders,
  tags,
} from "@/db/schema";
import { clip, iso, parseDate } from "@/lib/agent/shape";
import {
  AUTOMATIC_CATEGORIES,
  AUTOMATIC_REFUSAL,
  cleanLine,
  isPersonalCategory,
  isSameExchange,
  linkedinProfileUrl,
  NEAR_DUPLICATE_WINDOW_MS,
  PERSONAL_CATEGORIES,
  sanitizeAgentMarkdown,
} from "@/lib/agent/writes";
import { normalizeEmail } from "@/lib/contacts/normalize";
import type { ImportRow } from "@/lib/imports/types";
import { normalizeForSearch } from "@/lib/search/rank";
import type { WriteRecord } from "@/server/agent/ledger";
import {
  dateArg,
  defineTool,
  idempotencyKeyArg,
  idList,
  ToolRefusal,
  type AgentTool,
} from "@/server/agent/tool-kit";
import { undoAgentCall } from "@/server/agent/undo";
import { applyImportRow, matchContact } from "@/server/import-engine";
import { addNote, recordInteraction } from "@/server/interaction-core";
import { findOrCreateTag, setGroupMembership, setTagMembership } from "@/server/membership-core";
import { completeReminder, createReminder } from "@/server/reminder-core";
import { findContactsPrecisely } from "@/server/search";

// The connector's write tools (SPEC §14, Phase 15). What an agent may do
// to Rolo is narrow on purpose:
//
//   - append a record of something that happened (an exchange, a note, a
//     reminder), attributed to the agent and reversible;
//   - add a person, or fill in fields on one — through the import rules,
//     so nothing the owner typed is ever overwritten;
//   - put a tag on, take a tag off.
//
// Nothing here deletes, merges, archives, exports or touches settings,
// and the only thing that removes anything is undoing the agent's own
// earlier call. Each tool returns the rows it wrote so the dispatcher can
// ledger them for undo.

const MINUTE = 60 * 1000;
const NOTE_MAX = 5000;

function person(contactId: number): { id: number; name: string } {
  const row = db
    .select({ id: contacts.id, name: contacts.displayName })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .get();
  if (!row) throw new ToolRefusal(`There is no contact with id ${contactId}. Use find_contact or search_contacts first.`);
  return row;
}

function noteStamp(noteId: number): number | undefined {
  return db.select({ at: notes.updatedAt }).from(notes).where(eq(notes.id, noteId)).get()?.at;
}

/** A moment that has happened: not in the future, not absurdly old. */
function pastMoment(value: string, now: number, what: string): number {
  const at = parseDate(value);
  if (at === null) throw new ToolRefusal(`${what} is not a date.`);
  if (at > now + 10 * MINUTE) {
    throw new ToolRefusal(`${what} is in the future. Log things once they have happened; use create_reminder for what is planned.`);
  }
  if (at < Date.UTC(1990, 0, 1)) throw new ToolRefusal(`${what} is too far in the past to be right.`);
  return at;
}

// ---------- log_interaction ----------

const KIND_TO_STORED = { email: "email", message: "message", meeting: "meeting", call: "manual" } as const;

const logInteractionTool = defineTool({
  name: "log_interaction",
  title: "Log an exchange",
  description:
    "Record that the owner and a contact were in touch: an email, a message, a call or a meeting that has already happened. Only for exchanges a person actually wrote or took part in — say which with `category`; newsletters, notifications, automatic replies and bounces are refused, and when unsure, do not log. Resolve the person first (find_contact; upsert_contact if they are new). `occurredAt` is when it really happened — for a forwarded email, the original Sent time, not when the copy arrived. `idempotencyKey` must identify the message (for mail, `gmail:<message id>`), so reading the same message again changes nothing. A record of the same exchange that Rolo already holds is detected and not doubled. An email the owner received does not reset their keep-in-touch clock; one they sent does.",
  scope: "write",
  mutates: true,
  input: z
    .strictObject({
      contactId: z.number().int().positive(),
      kind: z.enum(["email", "message", "call", "meeting"]),
      direction: z
        .enum(["inbound", "outbound"])
        .optional()
        .describe("outbound = the owner wrote or called; inbound = the contact did. Required for email and message."),
      occurredAt: dateArg.describe("ISO-8601 time the exchange happened, with timezone offset."),
      subject: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .optional()
        .describe("Email subject, or one line saying what it was. Not the body."),
      category: z
        .enum([...PERSONAL_CATEGORIES, ...AUTOMATIC_CATEGORIES])
        .describe("What kind of message this is. The automatic kinds are refused."),
      note: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .optional()
        .describe("Optional summary in your own words: what was said, what was asked, what was agreed. Saved as a note beside the exchange."),
      gmailThreadId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/).optional(),
      idempotencyKey: idempotencyKeyArg,
    })
    .refine((v) => (v.kind !== "email" && v.kind !== "message") || v.direction !== undefined, {
      message: "direction is required for an email or a message.",
      path: ["direction"],
    }),
  run: (args, ctx) => {
    if (!isPersonalCategory(args.category)) throw new ToolRefusal(AUTOMATIC_REFUSAL);
    const who = person(args.contactId);
    const occurredAt = pastMoment(args.occurredAt, ctx.now, "occurredAt");
    const kind = KIND_TO_STORED[args.kind];
    const direction = args.direction ?? null;
    const title = args.subject ? cleanLine(args.subject, 300) : null;

    // Is this exchange already on the timeline under another id? The copy
    // the owner forwarded days later, a send Rolo recorded itself, the
    // same message read through a different mailbox.
    const nearby = db
      .select({
        id: interactions.id,
        kind: interactions.kind,
        direction: interactions.direction,
        occurredAt: interactions.occurredAt,
        title: interactions.title,
        source: interactions.source,
        sourceKey: interactions.sourceKey,
      })
      .from(interactions)
      .where(
        and(
          eq(interactions.contactId, who.id),
          eq(interactions.kind, kind),
          gte(interactions.occurredAt, occurredAt - NEAR_DUPLICATE_WINDOW_MS),
          lte(interactions.occurredAt, occurredAt + NEAR_DUPLICATE_WINDOW_MS)
        )
      )
      .all();
    const sameKey = nearby.find((r) => r.source === "agent" && r.sourceKey === args.idempotencyKey);
    const twin =
      sameKey ?? nearby.find((r) => isSameExchange(r, { kind, direction, occurredAt, title }));
    if (twin) {
      return {
        summary: `Already on ${who.name}'s timeline — not logged twice`,
        contactId: who.id,
        writes: [],
        data: {
          logged: false,
          alreadyRecorded: true,
          interactionId: twin.id,
          contactId: who.id,
          note: "Rolo already holds this exchange; nothing was added.",
        },
      };
    }

    const note = args.note ? sanitizeAgentMarkdown(args.note) : "";
    const res = recordInteraction({
      contactId: who.id,
      kind,
      direction,
      occurredAt,
      title,
      source: "agent",
      sourceKey: args.idempotencyKey,
      meta: {
        category: args.category,
        ...(args.kind === "call" ? { channel: "call" } : {}),
        ...(args.gmailThreadId ? { threadId: args.gmailThreadId } : {}),
      },
      noteMd: note || undefined,
    });
    if (!res.ok) throw new ToolRefusal(res.error);
    if (!res.created) {
      return {
        summary: `Already on ${who.name}'s timeline — not logged twice`,
        contactId: who.id,
        writes: [],
        data: { logged: false, alreadyRecorded: true, interactionId: res.interactionId, contactId: who.id },
      };
    }
    const writes: WriteRecord[] = [
      { table: "interactions", op: "insert", id: res.interactionId, contactId: who.id },
    ];
    if (res.noteId !== null) {
      writes.push({ table: "notes", op: "insert", id: res.noteId, contactId: who.id, stamp: noteStamp(res.noteId) });
    }
    const way =
      args.kind === "email" || args.kind === "message" ? `an ${direction} ${args.kind}` : `a ${args.kind}`;
    return {
      summary: `Logged ${way} with ${who.name}${title ? ` — ${clip(title, 80)}` : ""}`,
      contactId: who.id,
      writes,
      data: {
        logged: true,
        interactionId: res.interactionId,
        noteId: res.noteId,
        contactId: who.id,
        contactName: who.name,
        occurredAt: iso(occurredAt),
        resetsKeepInTouchClock: res.countsForTouch,
      },
    };
  },
});

// ---------- add_note ----------

const addNoteTool = defineTool({
  name: "add_note",
  title: "Add a note",
  description:
    "Write a note on a contact: something learned about them, what a conversation covered, a preference, a next step. Markdown. Write it as the owner's notes are written — facts and context, not a transcript, and never the full text of someone's email. Use log_interaction (with its `note`) when the note describes a specific exchange; use this for knowledge that is not one message. `date` backdates it to when the thing happened.",
  scope: "write",
  mutates: true,
  input: z.strictObject({
    contactId: z.number().int().positive(),
    text: z.string().trim().min(1).max(NOTE_MAX),
    date: dateArg.optional().describe("When this is about, if not now."),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  run: (args, ctx) => {
    const who = person(args.contactId);
    const body = sanitizeAgentMarkdown(args.text);
    if (!body) throw new ToolRefusal("The note is empty.");
    const createdAt = args.date ? pastMoment(args.date, ctx.now, "date") : ctx.now;
    // An agent's note is never itself a "touch": if contact happened, that
    // is an interaction, and log_interaction applies the rule for it.
    const res = addNote({ contactId: who.id, bodyMd: body, countsForTouch: false, createdAt });
    if (!res.ok) throw new ToolRefusal(res.error);
    return {
      summary: `Added a note on ${who.name}`,
      contactId: who.id,
      writes: [{ table: "notes", op: "insert", id: res.noteId, contactId: who.id, stamp: noteStamp(res.noteId) }],
      data: { added: true, noteId: res.noteId, contactId: who.id, contactName: who.name },
    };
  },
});

// ---------- reminders ----------

const createReminderTool = defineTool({
  name: "create_reminder",
  title: "Create a reminder",
  description:
    "Set a reminder for the owner, optionally attached to a contact: \"follow up if no reply\", \"send the deck\", \"call booked with Ana\". It appears on Rolo's Today page when due. One-off only.",
  scope: "write",
  mutates: true,
  input: z.strictObject({
    title: z.string().trim().min(1).max(200),
    dueAt: dateArg.describe("When it is due: ISO-8601 with timezone offset, or YYYY-MM-DD."),
    contactId: z.number().int().positive().optional(),
    details: z.string().trim().min(1).max(1000).optional(),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  run: (args, ctx) => {
    const who = args.contactId !== undefined ? person(args.contactId) : null;
    const dueAt = parseDate(args.dueAt);
    if (dueAt === null) throw new ToolRefusal("dueAt is not a date.");
    if (dueAt < ctx.now - 24 * 60 * MINUTE) {
      throw new ToolRefusal("dueAt is more than a day in the past. A reminder is for something still to do.");
    }
    if (dueAt > ctx.now + 5 * 365 * 24 * 60 * MINUTE) throw new ToolRefusal("dueAt is more than five years away.");
    const res = createReminder({
      title: cleanLine(args.title, 200),
      body: args.details ? sanitizeAgentMarkdown(args.details) : null,
      dueAt,
      contactId: who?.id ?? null,
    });
    if (!res.ok) throw new ToolRefusal(res.error);
    return {
      summary: `Set a reminder${who ? ` about ${who.name}` : ""} — ${clip(args.title, 80)}`,
      contactId: who?.id ?? null,
      writes: [
        {
          table: "reminders",
          op: "insert",
          id: res.reminderId,
          stamp: db.select({ at: reminders.updatedAt }).from(reminders).where(eq(reminders.id, res.reminderId)).get()?.at,
        },
      ],
      data: { created: true, reminderId: res.reminderId, dueAt: iso(dueAt), contactId: who?.id ?? null },
    };
  },
});

const completeReminderTool = defineTool({
  name: "complete_reminder",
  title: "Complete a reminder",
  description:
    "Mark a reminder done because what it was for has happened — the reply came, the call took place. Reminder ids come from get_today and get_contacts.",
  scope: "write",
  mutates: true,
  input: z.strictObject({
    reminderId: z.number().int().positive(),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  run: (args) => {
    const before = db.select().from(reminders).where(eq(reminders.id, args.reminderId)).get();
    if (!before) throw new ToolRefusal(`There is no reminder with id ${args.reminderId}.`);
    if (before.rrule !== null) {
      throw new ToolRefusal("That id is a recurring rule, not one of its occurrences. Complete the occurrence that is due.");
    }
    const newestBefore = db.select({ id: sql<number>`coalesce(max(${reminders.id}), 0)` }).from(reminders).get()?.id ?? 0;
    const res = completeReminder(args.reminderId);
    if (!res.ok) throw new ToolRefusal(res.error);
    if (!res.changed) {
      return {
        summary: `Reminder already complete — ${clip(before.title, 80)}`,
        contactId: res.contactId,
        writes: [],
        data: { completed: false, alreadyComplete: true, reminderId: args.reminderId },
      };
    }
    // Completing an occurrence of a recurring reminder materializes the next.
    const next =
      before.seriesId !== null
        ? db
            .select({ id: reminders.id })
            .from(reminders)
            .where(and(eq(reminders.seriesId, before.seriesId), gt(reminders.id, newestBefore)))
            .get()
        : undefined;
    return {
      summary: `Completed a reminder — ${clip(before.title, 80)}`,
      contactId: res.contactId,
      writes: [{ table: "reminders", op: "complete", id: args.reminderId, nextOccurrenceId: next?.id ?? null }],
      data: { completed: true, reminderId: args.reminderId },
    };
  },
});

// ---------- upsert_contact ----------

const nameField = z.string().trim().min(1).max(100);

/**
 * New people an agent may add in any 24 hours. Adding a person is the one
 * write that grows the address book, and a loop gone wrong — or mail
 * written to make an agent misbehave — should run out of road long before
 * it buries the owner's real contacts. A real batch belongs in an import.
 */
export const MAX_NEW_CONTACTS_PER_DAY = 50;

function contactsAddedSince(since: number): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(agentCalls)
      .where(
        and(
          eq(agentCalls.tool, "upsert_contact"),
          eq(agentCalls.status, "success"),
          isNull(agentCalls.undoneAt),
          gt(agentCalls.createdAt, since),
          sql`${agentCalls.writesJson} LIKE '%"table":"contacts","op":"insert"%'`
        )
      )
      .get()?.n ?? 0
  );
}

function maxId(table: typeof contactEmails | typeof contactSocials | typeof contactChanges): number {
  return db.select({ id: sql<number>`coalesce(max(${table.id}), 0)` }).from(table).get()?.id ?? 0;
}

const upsertContactTool = defineTool({
  name: "upsert_contact",
  title: "Add or update a person",
  description:
    "Add someone to Rolo, or fill in details on someone already there. To update a known person pass `contactId` (from find_contact) — the way to add the email address you found for an existing LinkedIn contact. Without `contactId`, Rolo matches by email or LinkedIn URL and updates that person; if nobody matches it creates a new contact, unless someone with the same name already exists, in which case it stops and shows them so you can choose. A field the owner typed, or that another source set, is never overwritten: it comes back under `conflicts` and stays as it was. Only add people the owner has actually been in contact with or asked for.",
  scope: "write",
  mutates: true,
  input: z
    .strictObject({
      contactId: z.number().int().positive().optional().describe("Update this contact."),
      firstName: nameField.optional(),
      lastName: nameField.optional(),
      title: z.string().trim().min(1).max(200).optional().describe("Current job title."),
      company: z.string().trim().min(1).max(200).optional().describe("Current employer."),
      location: z.string().trim().min(1).max(200).optional().describe("City, Country."),
      emails: z.array(z.string().trim().email().max(320)).min(1).max(5).optional(),
      linkedinUrl: z.string().trim().url().max(400).optional(),
      confirmNew: z
        .boolean()
        .optional()
        .describe("Create a new contact even though someone with the same name exists — only when you are sure they are different people."),
      idempotencyKey: idempotencyKeyArg.optional(),
    })
    .refine(
      (v) => v.firstName || v.lastName || v.title || v.company || v.location || v.emails || v.linkedinUrl,
      "Give at least one detail to add."
    ),
  run: (args, ctx) => {
    let linkedin: string | null = null;
    if (args.linkedinUrl) {
      linkedin = linkedinProfileUrl(args.linkedinUrl);
      if (!linkedin) throw new ToolRefusal("linkedinUrl is not a LinkedIn profile address (https://www.linkedin.com/in/…).");
    }
    const row: ImportRow = {
      firstName: args.firstName ? cleanLine(args.firstName, 100) : undefined,
      lastName: args.lastName ? cleanLine(args.lastName, 100) : undefined,
      title: args.title ? cleanLine(args.title, 200) : undefined,
      company: args.company ? cleanLine(args.company, 200) : undefined,
      location: args.location ? cleanLine(args.location, 200) : undefined,
      emails: (args.emails ?? []).map((email) => ({ email })),
      phones: [],
      socials: linkedin ? [{ platform: "linkedin", url: linkedin }] : [],
    };

    // Who is this row about?
    const matched = matchByIdentity(row);
    let targetId: number | null;
    if (args.contactId !== undefined) {
      person(args.contactId);
      // An email or profile that already belongs to someone else is a
      // sign the caller has the wrong person, or that two contacts are
      // one — neither is for an agent to settle by writing.
      const elsewhere = matched.filter((m) => m.contactId !== args.contactId);
      if (elsewhere.length > 0) {
        const other = person(elsewhere[0].contactId);
        throw new ToolRefusal(
          `That ${elsewhere[0].matchedBy === "email" ? "email address" : "LinkedIn profile"} already belongs to another contact: ${other.name} (id ${other.id}). Nothing was changed. If they are the same person, the owner can merge them in Rolo.`
        );
      }
      targetId = args.contactId;
    } else if (matched.length > 0) {
      if (new Set(matched.map((m) => m.contactId)).size > 1) {
        throw new ToolRefusal(
          `These details match more than one contact (ids ${[...new Set(matched.map((m) => m.contactId))].join(", ")}). Nothing was changed. Pass contactId for the one you mean.`
        );
      }
      targetId = matched[0].contactId;
    } else {
      targetId = null;
    }

    if (targetId === null) {
      const fullName = [row.firstName, row.lastName].filter(Boolean).join(" ");
      if (!fullName) {
        throw new ToolRefusal("A new contact needs a name. Give firstName and lastName, or contactId to update someone.");
      }
      if (!args.confirmNew) {
        const want = normalizeForSearch(fullName).replace(/\s+/g, " ");
        const namesakes = findContactsPrecisely(fullName, { includeArchived: true, nameOnly: true })
          .ids.slice(0, 50)
          .map((id) => person(id))
          .filter((p) => normalizeForSearch(p.name).replace(/\s+/g, " ") === want);
        if (namesakes.length > 0) {
          const rows = db
            .select({ id: contacts.id, name: contacts.displayName, title: contacts.title, company: contacts.company })
            .from(contacts)
            .where(inArray(contacts.id, namesakes.slice(0, 5).map((n) => n.id)))
            .all();
          return {
            summary: `Did not add ${fullName}: someone with that name is already in Rolo`,
            writes: [],
            data: {
              created: false,
              needsDecision: true,
              note: "Someone with this name is already in Rolo. If it is the same person, call again with their contactId to update them. If it is a different person, call again with confirmNew: true.",
              existing: rows.map((r) => ({ contactId: r.id, name: r.name, title: clip(r.title, 120), company: clip(r.company, 120) })),
            },
          };
        }
      }
    }

    if (targetId === null && contactsAddedSince(ctx.now - 24 * 60 * MINUTE) >= MAX_NEW_CONTACTS_PER_DAY) {
      throw new ToolRefusal(
        `${MAX_NEW_CONTACTS_PER_DAY} new contacts have been added through this connection in the last 24 hours, which is the limit. Nothing was added. Tell the owner; a larger batch is a job for Rolo's import page.`
      );
    }

    // Capture what undo needs before anything is written.
    const provenanceBefore = new Map<string, string>();
    if (targetId !== null) {
      for (const r of db
        .select({ field: contactFieldSources.field, source: contactFieldSources.source })
        .from(contactFieldSources)
        .where(eq(contactFieldSources.contactId, targetId))
        .all()) {
        provenanceBefore.set(r.field, r.source);
      }
    }
    const marks = { email: maxId(contactEmails), social: maxId(contactSocials), change: maxId(contactChanges) };

    const res =
      targetId !== null
        ? applyImportRow(row, { source: "agent", contactId: targetId })
        : // Nobody matched by email or profile, and a namesake was either
          // absent or explicitly ruled out: this is a new person, and the
          // import ladder's match-by-name must not decide otherwise.
          applyImportRow(row, { source: "agent", createNew: true });
    if (!res.ok) throw new ToolRefusal(res.error);
    const contactId = res.contactId;
    if (contactId === null) throw new ToolRefusal("The contact could not be written.");
    const who = person(contactId);
    const plan = res.plan;
    const conflicts = plan.conflicts.map((c) => ({
      field: c.field,
      kept: clip(c.stored, 200),
      setBy: c.storedSource === "user" ? "the owner" : c.storedSource,
      notApplied: clip(c.incoming, 200),
    }));

    if (targetId === null) {
      return {
        summary: `Added ${who.name} to Rolo`,
        contactId,
        writes: [{ table: "contacts", op: "insert", id: contactId }],
        data: { created: true, contactId, name: who.name },
      };
    }

    const idsAfter = <T extends typeof contactEmails | typeof contactSocials | typeof contactChanges>(
      table: T,
      mark: number
    ): number[] =>
      db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.contactId, contactId), gt(table.id, mark)))
        .all()
        .map((r) => r.id);
    const emailIds = idsAfter(contactEmails, marks.email);
    const socialIds = idsAfter(contactSocials, marks.social);
    const changeIds = idsAfter(contactChanges, marks.change);
    const changed = plan.writes.length > 0 || emailIds.length > 0 || socialIds.length > 0;
    const writes: WriteRecord[] = changed
      ? [
          {
            table: "contacts",
            op: "update",
            id: contactId,
            fields: plan.writes.map((w) => ({
              field: w.field,
              before: w.previous,
              beforeSource: provenanceBefore.get(w.field) ?? null,
              after: w.incoming,
            })),
            emailIds,
            socialIds,
            changeIds,
          },
        ]
      : [];
    const added = [
      ...plan.writes.map((w) => w.field.replace("_", " ")),
      ...(emailIds.length ? [emailIds.length === 1 ? "an email" : `${emailIds.length} emails`] : []),
      ...(socialIds.length ? ["a LinkedIn link"] : []),
    ];
    return {
      summary: changed
        ? `Updated ${who.name} — ${added.join(", ")}`
        : conflicts.length
          ? `Left ${who.name} unchanged — the stored details were kept`
          : `${who.name} was already up to date`,
      contactId,
      writes,
      data: {
        created: false,
        updated: changed,
        contactId,
        name: who.name,
        fieldsSet: plan.writes.map((w) => w.field),
        emailsAdded: emailIds.length,
        ...(conflicts.length
          ? {
              conflicts,
              note: "Conflicting fields were left as they were: Rolo keeps what the owner or another source set. Tell the owner if the difference matters.",
            }
          : {}),
      },
    };
  },
});

/** Every existing contact this row's email addresses and profile URL point at. */
function matchByIdentity(row: ImportRow): { contactId: number; matchedBy: "email" | "url" }[] {
  const out: { contactId: number; matchedBy: "email" | "url" }[] = [];
  for (const social of row.socials) {
    const hit = matchContact({ emails: [], phones: [], socials: [social] });
    if (hit) out.push({ contactId: hit.contactId, matchedBy: "url" });
  }
  for (const e of row.emails) {
    const hit = db
      .select({ contactId: contactEmails.contactId })
      .from(contactEmails)
      .where(eq(contactEmails.emailNormalized, normalizeEmail(e.email)))
      .get();
    if (hit) out.push({ contactId: hit.contactId, matchedBy: "email" });
  }
  return out;
}

// ---------- tag_contacts ----------

const tagName = z.string().trim().min(1).max(50);
const MAX_NEW_TAGS_PER_CALL = 2;

const tagContactsTool = defineTool({
  name: "tag_contacts",
  title: "Tag or group contacts",
  description:
    "Put tags on contacts, take tags off, or add and remove them from groups — up to 50 contacts at a time. Tags are given by name and matched case-insensitively against the owner's existing tags (see rolo_overview); reuse an existing tag rather than inventing a near-synonym. A name that matches nothing creates a new tag, at most two per call. Groups are given by id and must exist.",
  scope: "write",
  mutates: true,
  input: z
    .strictObject({
      contactIds: idList(50),
      addTags: z.array(tagName).min(1).max(5).optional(),
      removeTags: z.array(tagName).min(1).max(5).optional(),
      addToGroupIds: idList(5).optional(),
      removeFromGroupIds: idList(5).optional(),
      idempotencyKey: idempotencyKeyArg.optional(),
    })
    .refine((v) => v.addTags || v.removeTags || v.addToGroupIds || v.removeFromGroupIds, "Say what to add or remove."),
  run: (args) => {
    const ids = [...new Set(args.contactIds)];
    const known = new Set(
      db.select({ id: contacts.id }).from(contacts).where(inArray(contacts.id, ids)).all().map((c) => c.id)
    );
    const unknown = ids.filter((id) => !known.has(id));
    if (known.size === 0) throw new ToolRefusal("None of those contact ids exist.");
    const targets = ids.filter((id) => known.has(id));
    const writes: WriteRecord[] = [];
    const done: string[] = [];

    // Removals name things that must already exist; check before changing anything.
    const existingTag = (name: string) =>
      db
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(sql`lower(${tags.name}) = lower(${name.replace(/\s+/g, " ")})`)
        .get();
    const toRemove = (args.removeTags ?? []).map((name) => {
      const tag = existingTag(name);
      if (!tag) throw new ToolRefusal(`There is no tag called "${clip(name, 50)}".`);
      return tag;
    });
    for (const groupId of [...(args.addToGroupIds ?? []), ...(args.removeFromGroupIds ?? [])]) {
      if (!db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).get()) {
        throw new ToolRefusal(`There is no group with id ${groupId}.`);
      }
    }
    const brandNew = (args.addTags ?? []).filter((name) => !existingTag(name));
    if (new Set(brandNew.map((n) => n.toLowerCase())).size > MAX_NEW_TAGS_PER_CALL) {
      throw new ToolRefusal(
        `That would create ${brandNew.length} new tags (${brandNew.map((n) => `"${clip(n, 30)}"`).join(", ")}). At most ${MAX_NEW_TAGS_PER_CALL} per call — reuse the owner's existing tags where one fits.`
      );
    }

    for (const name of args.addTags ?? []) {
      const tag = findOrCreateTag(name);
      if (!tag.ok) throw new ToolRefusal(tag.error);
      if (tag.created) writes.push({ table: "tags", op: "insert", id: tag.tagId });
      const res = setTagMembership(targets, tag.tagId, true);
      if (!res.ok) throw new ToolRefusal(res.error);
      if (res.changedContactIds.length > 0) {
        writes.push({ table: "contact_tags", op: "add", tagId: tag.tagId, contactIds: res.changedContactIds });
      }
      done.push(`tagged ${res.changedContactIds.length} "${tag.name}"${tag.created ? " (new tag)" : ""}`);
    }
    for (const tag of toRemove) {
      const res = setTagMembership(targets, tag.id, false);
      if (!res.ok) throw new ToolRefusal(res.error);
      if (res.changedContactIds.length > 0) {
        writes.push({ table: "contact_tags", op: "remove", tagId: tag.id, contactIds: res.changedContactIds });
      }
      done.push(`untagged ${res.changedContactIds.length} "${tag.name}"`);
    }
    for (const groupId of args.addToGroupIds ?? []) {
      const res = setGroupMembership(targets, groupId, true);
      if (!res.ok) throw new ToolRefusal(res.error);
      if (res.changedContactIds.length > 0) {
        writes.push({ table: "group_members", op: "add", groupId, contactIds: res.changedContactIds });
      }
      done.push(`added ${res.changedContactIds.length} to group ${groupId}`);
    }
    for (const groupId of args.removeFromGroupIds ?? []) {
      const res = setGroupMembership(targets, groupId, false);
      if (!res.ok) throw new ToolRefusal(res.error);
      if (res.changedContactIds.length > 0) {
        writes.push({ table: "group_members", op: "remove", groupId, contactIds: res.changedContactIds });
      }
      done.push(`removed ${res.changedContactIds.length} from group ${groupId}`);
    }
    return {
      summary: `Tags and groups — ${done.join("; ")}`,
      contactId: targets.length === 1 ? targets[0] : null,
      writes,
      data: {
        contacts: targets.length,
        done,
        ...(unknown.length ? { unknownContactIds: unknown } : {}),
      },
    };
  },
});

// ---------- undo_agent_action ----------

const undoTool = defineTool({
  name: "undo_agent_action",
  title: "Undo an earlier action",
  description:
    "Reverse one earlier write made through this connector, by the `actionId` it returned: the interaction, note, reminder, contact, field or tag it added is taken back, and nothing else is touched. Use it when you logged something against the wrong person or the owner says it was a mistake. It cannot undo anything the owner did, and it will not remove a contact that has since gained other records.",
  scope: "write",
  mutates: true,
  destructive: true,
  input: z.strictObject({ actionId: z.number().int().positive() }),
  run: (args, ctx) => {
    const res = undoAgentCall(args.actionId, ctx.now);
    if (!res.ok) throw new ToolRefusal(res.error);
    return {
      summary: `Undid action ${args.actionId} — ${clip(res.summary ?? res.tool, 100)}`,
      contactId: res.contactId,
      writes: [],
      data: {
        undone: true,
        actionId: args.actionId,
        reversed: res.reversed,
        ...(res.skipped.length ? { leftInPlace: res.skipped } : {}),
      },
    };
  },
});

export const WRITE_TOOLS: AgentTool[] = [
  logInteractionTool,
  addNoteTool,
  createReminderTool,
  completeReminderTool,
  upsertContactTool,
  tagContactsTool,
  undoTool,
];
