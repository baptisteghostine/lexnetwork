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
  reminders,
  tags,
} from "@/db/schema";
import { clip, iso, parseDate } from "@/lib/agent/shape";
import {
  AUTOMATIC_CATEGORIES,
  AUTOMATIC_REFUSAL,
  cleanLine,
  cleanName,
  isPersonalCategory,
  isSameExchange,
  linkedinProfileUrl,
  NEAR_DUPLICATE_WINDOW_MS,
  normalizeSubject,
  PERSONAL_CATEGORIES,
  sanitizeAgentMarkdown,
} from "@/lib/agent/writes";
import { normalizeEmail } from "@/lib/contacts/normalize";
import { normalizeLinkedInUrl } from "@/lib/imports/linkedin";
import { parseMentions } from "@/lib/notes/mentions";
import type { ImportRow } from "@/lib/imports/types";
import { normalizeForSearch } from "@/lib/search/rank";
import { noteSignature, reminderSignature, type WriteRecord } from "@/server/agent/ledger";
import {
  dateArg,
  defineTool,
  idempotencyKeyArg,
  idList,
  ToolRefusal,
  type AgentTool,
} from "@/server/agent/tool-kit";
import { undoAgentCall } from "@/server/agent/undo";
import { CADENCE_DAYS_MAX, CADENCE_DAYS_MIN, setCadence } from "@/server/cadence-core";
import { applyImportRow, matchContact } from "@/server/import-engine";
import { addNote, recordInteraction } from "@/server/interaction-core";
import { findOrCreateTag, setGroupMembership, setTagMembership } from "@/server/membership-core";
import { completeReminder, createReminder } from "@/server/reminder-core";
import { findContactsPrecisely } from "@/server/search";
import { DRAFT_BODY_MAX, DRAFT_KINDS, DRAFT_SUBJECT_MAX } from "@/lib/outreach/compose";
import {
  CAMPAIGN_BRIEF_MAX,
  CAMPAIGN_GOAL_MAX,
  getCampaign,
  startOfLocalDay,
  saveCampaign,
  saveDraft,
  saveVoiceGuide,
  VOICE_GUIDE_MAX,
  VOICE_GUIDE_MIN,
} from "@/server/outreach-core";
import { EMAIL_PATTERN_EXAMPLE, EMAIL_PATTERNS } from "@/lib/outreach/email-pattern";
import { confirmGuess, guessBlock, recordBounce } from "@/server/email-guess-core";
import { FIRM_NOTE_MAX, setFirmEmailFormat, setFirmTier, TIER_NAME_MAX } from "@/server/firms-core";
import { suggestTags, TAG_EVIDENCE_MAX } from "@/server/tag-suggestion-core";
import { saveWhatsAppSummary, WA_SUMMARY_MAX, WA_SUMMARY_MIN } from "@/server/whatsapp-core";

// The connector's write tools (SPEC §14, Phase 15). What an agent may do
// to Rolo is narrow on purpose:
//
//   - append a record of something that happened (an exchange, a note, a
//     reminder), attributed to the agent and reversible;
//   - add a person, or fill in fields on one — through the import rules,
//     so nothing the owner typed is ever overwritten;
//   - put a tag on, take a tag off;
//   - set how often to keep in touch with someone (owner request,
//     2026-11-19: "put Chris in the CRM to reconnect every 3 months").
//
// Nothing here deletes, merges, archives, exports or touches settings,
// and the only thing that removes anything is undoing the agent's own
// earlier call. Each tool returns the rows it wrote so the dispatcher can
// ledger them for undo.

const MINUTE = 60 * 1000;
/** How far the owner's "Sent" click may be from when the email really left. */
const DRAFT_SEND_WINDOW_MS = 3 * 24 * 60 * MINUTE;
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

function noteRecord(noteId: number, contactId: number): WriteRecord {
  const mark = noteSignature(noteId);
  if (!mark) throw new Error("The note that was just written cannot be read back.");
  return { table: "notes", op: "insert", id: noteId, contactId, ...mark };
}

/**
 * A note's text, cleaned, with every @-mention checked: a mention puts
 * the note on that person's timeline too, so it has to point at someone
 * who exists.
 */
function noteBody(text: string): string {
  const body = sanitizeAgentMarkdown(text);
  for (const mention of parseMentions(body)) {
    const exists =
      mention.kind === "contact"
        ? db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, mention.id)).get()
        : db.select({ id: groups.id }).from(groups).where(eq(groups.id, mention.id)).get();
    if (!exists) {
      throw new ToolRefusal(
        `The note mentions ${mention.kind} ${mention.id}, which does not exist. Write the name as plain text, or use an id from Rolo.`
      );
    }
  }
  return body;
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
    // An email the owner sent from "Drafts to send" was logged when they
    // clicked Sent — which can be hours from when it really left. The
    // forwarded copy is that same email: found by its subject, within
    // three days, rather than by the ten-minute window.
    const fromDraft =
      kind === "email" && direction === "outbound" && title
        ? db
            .select({ id: interactions.id, title: interactions.title })
            .from(interactions)
            .where(
              and(
                eq(interactions.contactId, who.id),
                eq(interactions.kind, "email"),
                eq(interactions.direction, "outbound"),
                sql`${interactions.sourceKey} LIKE 'draft:%'`,
                gte(interactions.occurredAt, occurredAt - DRAFT_SEND_WINDOW_MS),
                lte(interactions.occurredAt, occurredAt + DRAFT_SEND_WINDOW_MS)
              )
            )
            .all()
            .find((r) => normalizeSubject(r.title) === normalizeSubject(title))
        : undefined;
    const twin =
      sameKey ?? fromDraft ?? nearby.find((r) => isSameExchange(r, { kind, direction, occurredAt, title }));
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

    const note = args.note ? noteBody(args.note) : "";
    const snoozedBefore =
      db.select({ at: contacts.snoozedUntil }).from(contacts).where(eq(contacts.id, who.id)).get()?.at ?? null;
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
      {
        table: "interactions",
        op: "insert",
        id: res.interactionId,
        contactId: who.id,
        key: args.idempotencyKey,
        ...(snoozedBefore !== null ? { snoozedBefore } : {}),
      },
    ];
    if (res.noteId !== null) writes.push(noteRecord(res.noteId, who.id));
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
    const body = noteBody(args.text);
    if (!body) throw new ToolRefusal("The note is empty.");
    const createdAt = args.date ? pastMoment(args.date, ctx.now, "date") : ctx.now;
    // An agent's note is never itself a "touch": if contact happened, that
    // is an interaction, and log_interaction applies the rule for it.
    const res = addNote({ contactId: who.id, bodyMd: body, countsForTouch: false, createdAt });
    if (!res.ok) throw new ToolRefusal(res.error);
    return {
      summary: `Added a note on ${who.name}`,
      contactId: who.id,
      writes: [noteRecord(res.noteId, who.id)],
      data: { added: true, noteId: res.noteId, contactId: who.id, contactName: who.name },
    };
  },
});

// ---------- reminders ----------

const createReminderTool = defineTool({
  name: "create_reminder",
  title: "Create a reminder",
  description:
    "Set a reminder for the owner, optionally attached to a contact: \"follow up if no reply\", \"send the deck\". It appears on Rolo's Today page when due. One-off only. When a call or meeting has been arranged, set the reminder at the time of the call with `purpose: \"call\"`.",
  scope: "write",
  mutates: true,
  input: z.strictObject({
    title: z.string().trim().min(1).max(200),
    dueAt: dateArg.describe("When it is due: ISO-8601 with timezone offset, or YYYY-MM-DD."),
    contactId: z.number().int().positive().optional(),
    details: z.string().trim().min(1).max(1000).optional(),
    purpose: z
      .enum(["call"])
      .optional()
      .describe("Set to \"call\" when this reminder is the time of a call or meeting that has been arranged with the contact. Their campaign stage then reads \"call booked\"."),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  run: (args, ctx) => {
    if (args.purpose === "call" && args.contactId === undefined) {
      throw new ToolRefusal("A call reminder has to be attached to the contact the call is with.");
    }
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
    const mark = reminderSignature(res.reminderId);
    if (!mark) throw new Error("The reminder that was just created cannot be read back.");
    return {
      summary: `Set a reminder${who ? ` about ${who.name}` : ""} — ${clip(args.title, 80)}`,
      contactId: who?.id ?? null,
      writes: [{ table: "reminders", op: "insert", id: res.reminderId, ...mark, ...(args.purpose ? { purpose: args.purpose } : {}) }],
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
    const completedAt =
      db.select({ at: reminders.completedAt }).from(reminders).where(eq(reminders.id, args.reminderId)).get()?.at ?? null;
    if (completedAt === null) throw new Error("The reminder did not complete.");
    const nextSig = next ? reminderSignature(next.id)?.sig : undefined;
    return {
      summary: `Completed a reminder — ${clip(before.title, 80)}`,
      contactId: res.contactId,
      writes: [
        {
          table: "reminders",
          op: "complete",
          id: args.reminderId,
          completedAt,
          nextOccurrenceId: next?.id ?? null,
          ...(nextSig ? { nextSig } : {}),
        },
      ],
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
      firstName: args.firstName ? cleanName(args.firstName, 100) || undefined : undefined,
      lastName: args.lastName ? cleanName(args.lastName, 100) || undefined : undefined,
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
        const candidates = findContactsPrecisely(fullName, { includeArchived: true, nameOnly: true }).ids.slice(0, 900);
        const namesakes = candidates.length
          ? db
              .select({ id: contacts.id, name: contacts.displayName })
              .from(contacts)
              .where(inArray(contacts.id, candidates))
              .all()
              .filter((p) => normalizeForSearch(p.name).replace(/\s+/g, " ") === want)
          : [];
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

    // On someone already in Rolo, two things the import rules would let
    // through are not an agent's to do.
    const extraConflicts: { field: string; kept: string; setBy: string; notApplied: string }[] = [];
    if (targetId !== null) {
      // A guess reaches a contact by the owner's click, never by this door (SPEC §17).
      for (const email of args.emails ?? []) {
        const blocked = guessBlock(targetId, email);
        if (blocked) throw new ToolRefusal(blocked);
      }
      const current = db.select().from(contacts).where(eq(contacts.id, targetId)).get();
      const typedByOwner = new Set(
        db
          .select({ field: contactFieldSources.field })
          .from(contactFieldSources)
          .where(and(eq(contactFieldSources.contactId, targetId), eq(contactFieldSources.source, "user")))
          .all()
          .map((r) => r.field)
      );
      // A field the owner emptied on purpose stays empty.
      for (const [key, field, column] of [
        ["firstName", "first_name", "firstName"],
        ["lastName", "last_name", "lastName"],
        ["title", "title", "title"],
        ["company", "company", "company"],
        ["location", "location", "location"],
      ] as const) {
        const incoming = row[key];
        if (incoming && typedByOwner.has(field) && !current?.[column]) {
          extraConflicts.push({ field, kept: "(left empty)", setBy: "the owner", notApplied: clip(incoming, 200) ?? "" });
          row[key] = undefined;
        }
      }
      // One LinkedIn profile per person: the same one in another spelling
      // is not added again, and a different one is the owner's call.
      if (linkedin) {
        const have = db
          .select({ url: contactSocials.url, source: contactSocials.source })
          .from(contactSocials)
          .where(and(eq(contactSocials.contactId, targetId), eq(contactSocials.platform, "linkedin")))
          .all();
        const want = normalizeLinkedInUrl(linkedin);
        if (have.some((h) => normalizeLinkedInUrl(h.url) === want)) {
          row.socials = [];
        } else if (have.length > 0) {
          extraConflicts.push({
            field: "linkedin",
            kept: have[0].url,
            setBy: have[0].source === "user" ? "the owner" : have[0].source,
            notApplied: linkedin,
          });
          row.socials = [];
        }
      }
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
    const conflicts = [
      ...plan.conflicts.map((c) => ({
        field: c.field as string,
        kept: clip(c.stored, 200) ?? "",
        setBy: c.storedSource === "user" ? "the owner" : c.storedSource,
        notApplied: clip(c.incoming, 200) ?? "",
      })),
      ...extraConflicts,
    ];
    const createdAt = db.select({ at: contacts.createdAt }).from(contacts).where(eq(contacts.id, contactId)).get()?.at ?? 0;

    if (targetId === null) {
      return {
        summary: `Added ${who.name} to Rolo`,
        contactId,
        writes: [{ table: "contacts", op: "insert", id: contactId, createdAt }],
        data: { created: true, contactId, name: who.name },
      };
    }

    const emails = db
      .select({ email: contactEmails.emailNormalized })
      .from(contactEmails)
      .where(and(eq(contactEmails.contactId, contactId), gt(contactEmails.id, marks.email)))
      .all()
      .map((r) => r.email);
    const socialUrls = db
      .select({ url: contactSocials.url })
      .from(contactSocials)
      .where(and(eq(contactSocials.contactId, contactId), gt(contactSocials.id, marks.social)))
      .all()
      .map((r) => r.url);
    const changeIds = db
      .select({ id: contactChanges.id })
      .from(contactChanges)
      .where(and(eq(contactChanges.contactId, contactId), gt(contactChanges.id, marks.change)))
      .all()
      .map((r) => r.id);
    const changed = plan.writes.length > 0 || emails.length > 0 || socialUrls.length > 0;
    const writes: WriteRecord[] = changed
      ? [
          {
            table: "contacts",
            op: "update",
            id: contactId,
            createdAt,
            fields: plan.writes.map((w) => ({
              field: w.field,
              before: w.previous,
              beforeSource: provenanceBefore.get(w.field) ?? null,
              after: w.incoming,
            })),
            emails,
            socialUrls,
            changeIds,
          },
        ]
      : [];
    const added = [
      ...plan.writes.map((w) => w.field.replace("_", " ")),
      ...(emails.length ? [emails.length === 1 ? "an email" : `${emails.length} emails`] : []),
      ...(socialUrls.length ? ["a LinkedIn link"] : []),
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
        emailsAdded: emails.length,
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
    // Every holder, not the first: an address two contacts share is a
    // question for the owner, not a coin toss.
    for (const hit of db
      .select({ contactId: contactEmails.contactId })
      .from(contactEmails)
      .where(eq(contactEmails.emailNormalized, normalizeEmail(e.email)))
      .all()) {
      out.push({ contactId: hit.contactId, matchedBy: "email" });
    }
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
    const addTags = (args.addTags ?? []).map((name) => cleanName(name, 50)).filter(Boolean);
    const brandNew = addTags.filter((name) => !existingTag(name));
    if (new Set(brandNew.map((n) => n.toLowerCase())).size > MAX_NEW_TAGS_PER_CALL) {
      throw new ToolRefusal(
        `That would create ${brandNew.length} new tags (${brandNew.map((n) => `"${clip(n, 30)}"`).join(", ")}). At most ${MAX_NEW_TAGS_PER_CALL} per call — reuse the owner's existing tags where one fits.`
      );
    }

    const groupName = (groupId: number) =>
      db.select({ name: groups.name }).from(groups).where(eq(groups.id, groupId)).get()?.name ?? "";
    for (const name of addTags) {
      const tag = findOrCreateTag(name);
      if (!tag.ok) throw new ToolRefusal(tag.error);
      if (tag.created) writes.push({ table: "tags", op: "insert", id: tag.tagId, name: tag.name });
      const res = setTagMembership(targets, tag.tagId, true);
      if (!res.ok) throw new ToolRefusal(res.error);
      if (res.changedContactIds.length > 0) {
        writes.push({ table: "contact_tags", op: "add", tagId: tag.tagId, tagName: tag.name, contactIds: res.changedContactIds, at: Date.now() });
      }
      done.push(`tagged ${res.changedContactIds.length} "${tag.name}"${tag.created ? " (new tag)" : ""}`);
    }
    for (const tag of toRemove) {
      const res = setTagMembership(targets, tag.id, false);
      if (!res.ok) throw new ToolRefusal(res.error);
      if (res.changedContactIds.length > 0) {
        writes.push({ table: "contact_tags", op: "remove", tagId: tag.id, tagName: tag.name, contactIds: res.changedContactIds, at: Date.now() });
      }
      done.push(`untagged ${res.changedContactIds.length} "${tag.name}"`);
    }
    for (const groupId of args.addToGroupIds ?? []) {
      const res = setGroupMembership(targets, groupId, true);
      if (!res.ok) throw new ToolRefusal(res.error);
      if (res.changedContactIds.length > 0) {
        writes.push({ table: "group_members", op: "add", groupId, groupName: groupName(groupId), contactIds: res.changedContactIds, at: Date.now() });
      }
      done.push(`added ${res.changedContactIds.length} to group ${groupId}`);
    }
    for (const groupId of args.removeFromGroupIds ?? []) {
      const res = setGroupMembership(targets, groupId, false);
      if (!res.ok) throw new ToolRefusal(res.error);
      if (res.changedContactIds.length > 0) {
        writes.push({ table: "group_members", op: "remove", groupId, groupName: groupName(groupId), contactIds: res.changedContactIds, at: Date.now() });
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

// ---------- set_cadence ----------

const RHYTHMS: Record<number, string> = {
  7: "every week",
  14: "every 2 weeks",
  30: "every month",
  42: "every 6 weeks",
  91: "every 3 months",
  182: "every 6 months",
  365: "every year",
};

function rhythm(days: number | null): string {
  return days === null ? "no keep-in-touch rhythm" : (RHYTHMS[days] ?? `every ${days} days`);
}

const setCadenceTool = defineTool({
  name: "set_cadence",
  title: "Set how often to keep in touch",
  description:
    "Put contacts on a keep-in-touch rhythm, or take them off one — when the owner asks for it (\"reconnect with Chris every 3 months\"), never on your own judgment. `everyDays` is the gap in days. Use Rolo's standard rhythms where one fits, so the person lands in the matching column of the Keep-in-touch board: 7 (weekly), 14 (every 2 weeks), 30 (monthly), 42 (every 6 weeks), 91 (every 3 months), 182 (every 6 months), 365 (yearly). `null` takes them off: they stop coming up as due. The clock runs from the last time the owner was in touch, or from now if they never were; the answer says when each person next comes due on Rolo's Today page. Up to 50 contacts per call. Resolve people first with find_contact — if a name matches two contacts, ask the owner which one, or tell them the two look like duplicates.",
  scope: "write",
  mutates: true,
  input: z.strictObject({
    contactIds: idList(50),
    everyDays: z
      .number()
      .int()
      .min(CADENCE_DAYS_MIN)
      .max(CADENCE_DAYS_MAX)
      .nullable()
      .describe("Days between touches, or null to stop keeping in touch."),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  run: (args, ctx) => {
    const ids = [...new Set(args.contactIds)];
    const people = db
      .select({
        id: contacts.id,
        name: contacts.displayName,
        createdAt: contacts.createdAt,
        cadenceDays: contacts.cadenceDays,
        archivedAt: contacts.archivedAt,
      })
      .from(contacts)
      .where(inArray(contacts.id, ids))
      .all();
    if (people.length === 0) throw new ToolRefusal("None of those contact ids exist.");
    const known = new Set(people.map((p) => p.id));
    const unknown = ids.filter((id) => !known.has(id));
    const archived = people.filter((p) => p.archivedAt !== null);
    if (archived.length > 0 && args.everyDays !== null) {
      throw new ToolRefusal(
        `${archived.map((p) => p.name).join(", ")} ${archived.length === 1 ? "is" : "are"} archived, and an archived contact is not kept in touch with. Nothing was changed. The owner can unarchive them in Rolo.`
      );
    }
    const writes: WriteRecord[] = [];
    const results: Record<string, unknown>[] = [];
    for (const p of people) {
      if (p.cadenceDays === args.everyDays) {
        results.push({ contactId: p.id, name: p.name, changed: false, keepInTouch: rhythm(p.cadenceDays) });
        continue;
      }
      const res = setCadence(p.id, args.everyDays, ctx.now);
      if (!res.ok) throw new ToolRefusal(res.error);
      writes.push({ table: "contacts", op: "cadence", id: p.id, createdAt: p.createdAt, before: res.before, after: res.after });
      results.push({
        contactId: p.id,
        name: p.name,
        changed: true,
        keepInTouch: rhythm(args.everyDays),
        was: rhythm(res.before.cadenceDays),
        nextDue: iso(res.nextTouchAt),
      });
    }
    const changed = results.filter((r) => r.changed);
    const who = changed.length === 1 ? String(changed[0].name) : `${changed.length} contacts`;
    return {
      summary:
        changed.length === 0
          ? `Keep-in-touch rhythm already ${rhythm(args.everyDays)} — nothing changed`
          : args.everyDays === null
            ? `Took ${who} off keep-in-touch`
            : `Set ${who} to keep in touch ${rhythm(args.everyDays)}`,
      contactId: people.length === 1 ? people[0].id : null,
      writes,
      data: {
        changed: changed.length,
        contacts: results,
        ...(unknown.length ? { unknownContactIds: unknown } : {}),
      },
    };
  },
});

// ---------- save_whatsapp_summary ----------

const saveWhatsAppSummaryTool = defineTool({
  name: "save_whatsapp_summary",
  title: "Update a WhatsApp summary",
  description:
    "Replace the rolling summary of one linked contact's WhatsApp history. There is one summary per contact and it is rewritten each time, not added to: read the existing summary and the messages after its `coversThrough` (get_whatsapp_chat, `order: \"oldest\"`), then write a single updated text that folds the new messages into what was there. It has to let the owner pick the relationship up once the exact words are gone, so cover: the topics discussed; plans made; commitments in both directions and whether they were kept; personal updates the person shared (work, moves, family, health); and how the relationship is evolving. Plain prose under a few short headings; quote only where the wording matters. `coversThrough` is the time of the last message you included, and it is a promise: Rolo clears exact text only when it is older than 90 days AND at or before `coversThrough`, and a week after that — so never set it later than what you actually read, and read every message up to it. list_whatsapp_chats shows which chats have text waiting.",
  scope: "write",
  mutates: true,
  input: z.strictObject({
    contactId: z.number().int().positive(),
    summary: z.string().trim().min(WA_SUMMARY_MIN).max(WA_SUMMARY_MAX),
    coversThrough: dateArg.describe("ISO-8601 time of the last message the summary includes."),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  run: (args, ctx) => {
    const who = person(args.contactId);
    const covers = parseDate(args.coversThrough);
    if (covers === null) throw new ToolRefusal("coversThrough is not a date.");
    const text = sanitizeAgentMarkdown(args.summary);
    const res = saveWhatsAppSummary(who.id, text, covers, ctx.now);
    if (!res.ok) throw new ToolRefusal(res.error);
    return {
      summary: `Updated the WhatsApp summary for ${who.name}`,
      contactId: who.id,
      writes: [{ table: "whatsapp_links", op: "summary", id: res.linkId, contactId: who.id, updatedAt: res.updatedAt }],
      data: {
        saved: true,
        contactId: who.id,
        coversThrough: iso(res.coversThrough),
        note: "Exact text at or before coversThrough will be cleared once it is more than 90 days old, a week after it becomes due. Undo this action within that week if the summary is wrong.",
      },
    };
  },
});

// ---------- outreach (SPEC §16) ----------

const saveCampaignTool = defineTool({
  name: "save_campaign",
  title: "Create or update a campaign",
  description:
    "A campaign is a goal the owner is reaching out to people for — \"tech investment banking, top firms\" — with a brief and a list of people. In Rolo it is a group plus that brief; where each person stands is worked out from what has actually been sent and answered, never set by hand. Without `campaignId` this creates a new campaign called `name`; with it, it updates the goal and brief (or turns an existing group into a campaign). `brief` is markdown: who fits and why, the angle of the first email, what the owner is asking for, anything to avoid. Only what was sent since the campaign began counts towards it, so if the owner started writing to these people before today, say when with `startedOn`. `addContactIds` puts people in (up to 50 a call); use tag_contacts to take someone out. Create or change a campaign only when the owner asks.",
  scope: "write",
  mutates: true,
  input: z
    .strictObject({
      campaignId: z.number().int().positive().optional().describe("The campaign (group) to update. Omit to create a new one."),
      name: z.string().trim().min(1).max(80).optional().describe("Name for a new campaign."),
      goal: z.string().trim().min(1).max(CAMPAIGN_GOAL_MAX).describe("One line: what this outreach is for."),
      brief: z.string().trim().min(1).max(CAMPAIGN_BRIEF_MAX).optional(),
      startedOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("YYYY-MM-DD. The day this outreach began, if before today: emails sent from that day count towards it. Defaults to the day the campaign is created."),
      addContactIds: idList(50).optional(),
      idempotencyKey: idempotencyKeyArg.optional(),
    })
    .refine((v) => v.campaignId !== undefined || v.name !== undefined, "Give a name for a new campaign, or campaignId to update one."),
  run: (args, ctx) => {
    const existing = args.campaignId !== undefined ? getCampaign(args.campaignId) : null;
    const startedAt = args.startedOn !== undefined ? startOfLocalDay(args.startedOn) : undefined;
    if (startedAt === null) throw new ToolRefusal(`"${args.startedOn}" is not a date.`);
    const res = saveCampaign(
      {
        startedAt,
        groupId: args.campaignId,
        name: args.name ? cleanName(args.name, 80) : undefined,
        goal: cleanLine(args.goal, CAMPAIGN_GOAL_MAX),
        briefMd: args.brief !== undefined ? sanitizeAgentMarkdown(args.brief) : (existing?.briefMd ?? ""),
      },
      ctx.now
    );
    if (!res.ok) throw new ToolRefusal(res.error);
    const writes: WriteRecord[] = [
      { table: "campaigns", op: "save", groupId: res.groupId, groupName: res.name, marker: res.marker, createdGroup: res.createdGroup, createdCampaign: res.createdCampaign },
    ];
    let added = 0;
    let unknown: number[] = [];
    if (args.addContactIds) {
      const membership = setGroupMembership([...new Set(args.addContactIds)], res.groupId, true);
      if (!membership.ok) throw new ToolRefusal(membership.error);
      added = membership.changedContactIds.length;
      unknown = membership.unknownContactIds;
      if (added > 0) {
        writes.push({ table: "group_members", op: "add", groupId: res.groupId, groupName: res.name, contactIds: membership.changedContactIds, at: Date.now() });
      }
    }
    return {
      summary: `${res.createdCampaign ? "Created" : "Updated"} the campaign "${clip(res.name, 60)}"${added ? ` and added ${added} ${added === 1 ? "person" : "people"}` : ""}`,
      writes,
      data: {
        campaignId: res.groupId,
        name: res.name,
        created: res.createdCampaign,
        peopleAdded: added,
        ...(unknown.length ? { unknownContactIds: unknown } : {}),
      },
    };
  },
});

// ---------- firms and address guesses (SPEC §17) ----------

const recordEmailFormatTool = defineTool({
  name: "record_email_format",
  title: "Record how a firm forms its email addresses",
  description:
    "Tell Rolo how a firm builds its addresses, so it can suggest one for people it has none for (suggest_emails). Record only what you have evidence for: `basis: \"seen_in_mail\"` when you have read real addresses at that firm in the owner's mail (say how many, and that they agree, in `note` — never paste the addresses of people who are not in Rolo), `basis: \"published\"` when a public source states the format (name the source in `note`). `company` is the employer as list_companies spells it; `domain` is what follows the @. `pattern` describes the part before it, shown here for \"Ana Silva\": " +
    EMAIL_PATTERNS.map((p) => `${p} → ${EMAIL_PATTERN_EXAMPLE[p]}`).join(", ") +
    ". A format the owner set themselves is never replaced. This puts no address on anyone: the owner accepts each guess in Rolo.",
  scope: "write",
  mutates: true,
  input: z.strictObject({
    company: z.string().trim().min(1).max(200),
    domain: z.string().trim().min(3).max(253),
    pattern: z.enum(EMAIL_PATTERNS),
    basis: z.enum(["seen_in_mail", "published"]),
    note: z.string().trim().min(1).max(FIRM_NOTE_MAX).describe("Where this comes from, in one line."),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  run: (args, ctx) => {
    const res = setFirmEmailFormat({ company: args.company, domain: args.domain, pattern: args.pattern, basis: args.basis, note: args.note, source: "agent" }, ctx.now);
    if (!res.ok) throw new ToolRefusal(res.error);
    const shown = `${EMAIL_PATTERN_EXAMPLE[args.pattern]}@${res.after.emailDomain}`;
    return {
      summary: res.changed ? `Recorded ${clip(res.name, 60)}'s address format as ${shown}` : `${clip(res.name, 60)}'s address format was already ${shown}`,
      writes: res.changed ? [{ table: "firms", op: "email_format", key: res.key, name: res.name, before: res.before, after: res.after }] : [],
      data: {
        recorded: res.changed,
        firm: res.name,
        format: shown,
        note: "Rolo will now suggest addresses at this firm as guesses. The owner accepts each one in Rolo; you cannot.",
      },
    };
  },
});

const recordEmailOutcomeTool = defineTool({
  name: "record_email_outcome",
  title: "Record that an address bounced, or that it works",
  description:
    "What happened to an email the owner sent, as you saw it in their mail. `outcome: \"bounced\"` when a delivery failure came back for that address: if the address was a guess, Rolo takes it off the contact, remembers it as wrong and offers the next one; if it was an address Rolo was given, it stays and the contact is tagged \"bad address\". Either way the email it was sent in stops counting as sent, so nobody shows as waiting on a reply to it — always give its `subject` (from the failure notice) so Rolo marks the right one; without it Rolo takes the latest unanswered email, and marks none when the person has several addresses. Reporting the same bounce twice changes nothing the second time. `outcome: \"confirmed\"` when the person answered from that address: a guess stops being a guess, and counts as evidence for the firm's format. Report only what a message actually shows; an out-of-office is neither.",
  scope: "write",
  mutates: true,
  input: z.strictObject({
    contactId: z.number().int().positive(),
    email: z.string().trim().email().max(320),
    outcome: z.enum(["bounced", "confirmed"]),
    subject: z.string().trim().min(1).max(300).optional().describe("For a bounce: the subject of the email that came back."),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  run: (args, ctx) => {
    const who = person(args.contactId);
    if (args.outcome === "confirmed") {
      const res = confirmGuess(who.id, args.email, ctx.now);
      if (!res.ok) throw new ToolRefusal(res.error);
      return {
        summary: res.changed ? `Confirmed ${clip(who.name, 60)}'s address` : `${clip(who.name, 60)}'s address needed no confirming`,
        contactId: who.id,
        writes: res.changed ? [{ table: "email_guesses", op: "confirm", contactId: who.id, email: normalizeEmail(args.email), previous: res.previous ?? "accepted" }] : [],
        data: {
          confirmed: res.changed,
          ...(res.changed ? {} : { note: res.wasGuess ? "It was already confirmed." : "That address was not a guess, so there was nothing to confirm." }),
        },
      };
    }
    const res = recordBounce({ contactId: who.id, email: args.email, subject: args.subject ?? null }, ctx.now);
    if (!res.ok) throw new ToolRefusal(res.error);
    const r = res.record;
    const changed = r.retracted !== null || r.tagged !== null || r.send !== null;
    const did = [
      r.retracted ? "took the guessed address off the contact" : null,
      r.tagged ? `tagged them "${r.tagged.tagName}"` : null,
      r.send ? "stopped counting the email as sent" : null,
    ].filter(Boolean);
    return {
      summary: changed ? `Recorded a bounce for ${clip(who.name, 60)}: ${did.join(", ")}` : `A bounce for ${clip(who.name, 60)} was already recorded`,
      contactId: who.id,
      writes: changed ? [{ table: "email_guesses", op: "bounce", record: r }] : [],
      data: {
        recorded: changed,
        guessRemoved: r.retracted !== null,
        taggedBadAddress: r.tagged !== null,
        emailNoLongerCountsAsSent: r.send !== null ? clip(res.sendTitle, 200) : null,
        ...(r.send === null
          ? {
              note:
                res.noSend === "needs_subject"
                  ? "This person has more than one address, so Rolo cannot tell which email came back. Nothing on the timeline was changed: call again with the subject of the email that bounced."
                  : res.noSend === "already_recorded"
                    ? "This bounce was already recorded; nothing more was changed."
                    : "No unanswered email to this person in the last three weeks matched, so nothing on the timeline was changed.",
            }
          : {}),
        ...(res.next.length > 0
          ? { nextGuess: { email: res.next[0].email, strength: res.next[0].strength, evidence: clip(res.next[0].evidence, 400) }, tellTheOwner: "Another address can be tried. The owner accepts it in Rolo; you cannot." }
          : {}),
      },
    };
  },
});

const MAX_TIERS_PER_CALL = 6;

const proposeFirmTiersTool = defineTool({
  name: "propose_firm_tiers",
  title: "Propose tiers for firms",
  description:
    "Propose which tier each firm belongs to — for investment banks, say, \"Bulge bracket\", \"Elite boutique\", \"Mid-market\" — so that \"the top firms\" means something exact in searches and campaigns. This is always a proposal: it waits on Rolo's activity page until the owner approves or rejects it, and changes nothing before. Use tier names already in use where they fit (list_companies returns them), at most six different tiers in a call, and give one line of reasoning per firm. `company` is the employer as list_companies spells it; other spellings of the same firm are covered by it. A tier the owner set themselves is never replaced. Do this when the owner asks for firms to be ranked or grouped.",
  scope: "write",
  mutates: true,
  alwaysReview: true,
  input: z.strictObject({
    firms: z
      .array(
        z.strictObject({
          company: z.string().trim().min(1).max(200),
          tier: z.string().trim().min(1).max(TIER_NAME_MAX),
          why: z.string().trim().min(1).max(FIRM_NOTE_MAX),
        })
      )
      .min(1)
      .max(40),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  run: (args, ctx) => {
    const distinct = new Set(args.firms.map((f) => cleanName(f.tier, TIER_NAME_MAX).toLowerCase()));
    if (distinct.size > MAX_TIERS_PER_CALL) throw new ToolRefusal(`At most ${MAX_TIERS_PER_CALL} different tiers in one proposal.`);
    const writes: WriteRecord[] = [];
    const set: { firm: string; tier: string }[] = [];
    const kept: { firm: string; why: string }[] = [];
    for (const f of args.firms) {
      const res = setFirmTier({ company: f.company, tier: f.tier, note: f.why, source: "agent" }, ctx.now);
      if (!res.ok) {
        // One the owner decided is reported, not fought over; anything else stops the proposal.
        if (res.conflict) {
          kept.push({ firm: clip(f.company, 120) ?? "", why: res.error });
          continue;
        }
        throw new ToolRefusal(res.error);
      }
      if (!res.changed) continue;
      writes.push({ table: "firms", op: "tier", key: res.key, name: res.name, before: res.before, after: res.after });
      set.push({ firm: res.name, tier: res.after.tier ?? "" });
    }
    return {
      summary: `Set the tier of ${set.length} firm${set.length === 1 ? "" : "s"}`,
      writes,
      data: { firmsSet: set.length, set, ...(kept.length ? { keptAsTheOwnerSetThem: kept } : {}) },
    };
  },
});

const suggestTagsTool = defineTool({
  name: "suggest_tags",
  title: "Suggest tags for people, with the evidence",
  description:
    "Propose a tag for a person when you have evidence for something their headline does not say — above all the team or sector they cover (\"TMT\", \"Healthcare\"), read from a role description, a deal announcement or the owner's own mail. Each suggestion waits in Rolo (AI → Suggestions to review) with your evidence beside it, and nothing is tagged until the owner approves it there. `evidence` is one line the owner can check: what you read and where. No evidence, no suggestion — do not infer a team from the firm alone. Use tag names already in use where they fit (rolo_overview lists them). For a fact the owner has told you directly, use tag_contacts instead.",
  scope: "write",
  mutates: true,
  input: z.strictObject({
    suggestions: z
      .array(
        z.strictObject({
          contactId: z.number().int().positive(),
          tag: z.string().trim().min(1).max(50),
          evidence: z.string().trim().min(8).max(TAG_EVIDENCE_MAX),
        })
      )
      .min(1)
      .max(40),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  run: (args, ctx) => {
    const res = suggestTags(args.suggestions, ctx.now);
    return {
      summary: `Suggested ${res.created.length} tag${res.created.length === 1 ? "" : "s"} for the owner to review`,
      contactId: res.created.length === 1 ? res.created[0].contactId : undefined,
      writes: res.created.length > 0 ? [{ table: "ai_suggestions", op: "insert", ids: res.created.map((c) => c.id), createdAt: ctx.now }] : [],
      data: {
        suggested: res.created.length,
        ...(res.skipped.length ? { leftOut: res.skipped.slice(0, 40) } : {}),
        note: "Nothing is tagged yet. The suggestions are in Rolo under AI → Suggestions to review; tell the owner they are there.",
      },
    };
  },
});

const saveDraftTool = defineTool({
  name: "save_draft",
  title: "Save a draft for the owner to send",
  description:
    "Put an email in Rolo's \"Drafts to send\" for the owner to send from their own mail account. Rolo never sends anything: the owner opens the draft in Outlook, sends it, and clicks Sent. Write it in the owner's voice (get_voice_guide) and from what Rolo knows about the person (get_contacts). `kind`: `first` for a first email, `nudge` for the follow-up after no reply, `reply` for an answer to something they wrote. Plain text, no markdown; no placeholders — if something is unknown, leave it out. It is addressed to the contact's own email in Rolo; a contact with none can still have a draft, and the owner is told the address is missing. One open draft per person per campaign: to change one, pass `replaceDraftId`. Do not draft for someone who is already waiting on the owner's reply, or whose campaign stage is \"not pursuing\".",
  scope: "write",
  mutates: true,
  input: z.strictObject({
    contactId: z.number().int().positive(),
    campaignId: z.number().int().positive().optional(),
    kind: z.enum(DRAFT_KINDS),
    subject: z.string().trim().min(1).max(DRAFT_SUBJECT_MAX),
    body: z.string().trim().min(1).max(DRAFT_BODY_MAX).describe("The email as plain text, greeting to sign-off."),
    toEmail: z.string().trim().email().max(320).optional().describe("Only an address already on the contact. Defaults to their first."),
    replaceDraftId: z.number().int().positive().optional(),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  run: (args, ctx) => {
    const who = person(args.contactId);
    const res = saveDraft(
      {
        contactId: who.id,
        groupId: args.campaignId ?? null,
        kind: args.kind,
        subject: cleanLine(args.subject, DRAFT_SUBJECT_MAX),
        body: args.body,
        toEmail: args.toEmail ?? null,
        source: "agent",
        replaceDraftId: args.replaceDraftId ?? null,
      },
      ctx.now
    );
    if (!res.ok) throw new ToolRefusal(res.error);
    return {
      summary: `Drafted ${args.kind === "nudge" ? "a follow-up" : args.kind === "reply" ? "a reply" : "an email"} to ${who.name} — ${clip(res.draft.subject, 80)}`,
      contactId: who.id,
      writes: [{ table: "outreach_drafts", op: "insert", id: res.draft.id, contactId: who.id, createdAt: res.draft.createdAt, replacedId: res.replacedId }],
      data: {
        saved: true,
        draftId: res.draft.id,
        contactId: who.id,
        to: res.draft.toEmail,
        ...(res.draft.toEmail ? {} : { note: `Rolo has no email address for ${who.name}. The draft is saved; the owner will need the address before sending.` }),
        ...(res.replacedId !== null ? { replacedDraftId: res.replacedId } : {}),
      },
    };
  },
});

const updateVoiceGuideTool = defineTool({
  name: "update_voice_guide",
  title: "Update the voice guide",
  description:
    "Replace the owner's voice guide: the description of how they write that every draft is written from. Build it from emails the owner really sent (read them through the mail connector): how they open and sign off, sentence length, formality, how they introduce themselves and their school, how they make the ask, phrases they use and ones they never do, the usual length. Write it as instructions another writer could follow, with two or three short examples of their own phrasing. One guide, rewritten whole each time. Do this when the owner asks.",
  scope: "write",
  mutates: true,
  input: z.strictObject({
    guide: z.string().trim().min(VOICE_GUIDE_MIN).max(VOICE_GUIDE_MAX),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  run: (args, ctx) => {
    const res = saveVoiceGuide(sanitizeAgentMarkdown(args.guide), ctx.now);
    if (!res.ok) throw new ToolRefusal(res.error);
    return {
      summary: "Updated the voice guide",
      writes: [{ table: "settings", op: "voice_guide", marker: res.marker }],
      data: { saved: true },
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
  setCadenceTool,
  saveWhatsAppSummaryTool,
  saveCampaignTool,
  saveDraftTool,
  updateVoiceGuideTool,
  recordEmailFormatTool,
  recordEmailOutcomeTool,
  proposeFirmTiersTool,
  suggestTagsTool,
  undoTool,
];
