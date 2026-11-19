import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts, interactions, notes } from "@/db/schema";
import { isSameExchange } from "@/lib/agent/writes";
import { interactionCountsForTouch } from "@/lib/cadence/engine";
import { recomputeContact } from "@/lib/cadence/recompute";
import { mentionedContactIds, syncNoteMentions } from "@/server/note-sync";

// Writing an interaction or a note, without a session (SPEC §14, Phase 13).
//
// These are the cores behind "Log interaction", the quick log and the note
// actions, and they are what the agent connector calls. They check
// nothing about who is asking — the server action gates on the cookie,
// the connector on its token — and they do not revalidate pages: they
// return the contacts they touched and the caller decides what to refresh.
//
// Never export these from a "use server" file: that would make them
// endpoints a browser can call without logging in.

export const INTERACTION_KINDS = ["manual", "meeting", "message", "email"] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];
export type InteractionDirection = "inbound" | "outbound";

export const INTERACTION_TITLE_MAX = 500;
export const NOTE_BODY_MAX = 200_000;

export type RecordInteractionInput = {
  contactId: number;
  kind: InteractionKind;
  /** When it happened (epoch ms) — not when it was logged. */
  occurredAt: number;
  title?: string | null;
  direction?: InteractionDirection | null;
  /** Who is writing: 'user' for the owner's own logging, 'agent' for the connector. */
  source: string;
  /**
   * Idempotency key, unique per (contact, source). A second call with the
   * same key writes nothing and returns the first row — for mail it is the
   * id of the message that was read.
   */
  sourceKey?: string | null;
  /** Stored as JSON: thread id, link, other participants. Never a mail body. */
  meta?: Record<string, unknown> | null;
  /** Optional markdown → a note row dated to the interaction (SPEC §2). */
  noteMd?: string;
};

export type CoreError = { ok: false; error: string };

export type RecordInteractionResult =
  | {
      ok: true;
      interactionId: number;
      noteId: number | null;
      /** False when `sourceKey` matched a row that was already there. */
      created: boolean;
      countsForTouch: boolean;
    }
  | CoreError;

function contactExists(contactId: number): boolean {
  return (
    db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).get() !==
    undefined
  );
}

export function recordInteraction(input: RecordInteractionInput): RecordInteractionResult {
  if (!INTERACTION_KINDS.includes(input.kind)) return { ok: false, error: "Unknown interaction kind." };
  if (!Number.isInteger(input.occurredAt) || input.occurredAt <= 0) {
    return { ok: false, error: "occurredAt must be a timestamp in milliseconds." };
  }
  const direction = input.direction ?? null;
  if (direction !== null && direction !== "inbound" && direction !== "outbound") {
    return { ok: false, error: "direction must be inbound, outbound or absent." };
  }
  const title = input.title?.trim() || null;
  if (title && title.length > INTERACTION_TITLE_MAX) {
    return { ok: false, error: `Title is longer than ${INTERACTION_TITLE_MAX} characters.` };
  }
  const noteMd = input.noteMd?.trim() ?? "";
  if (noteMd.length > NOTE_BODY_MAX) return { ok: false, error: "Note is too long." };
  const sourceKey = input.sourceKey?.trim() || null;
  if (!input.source) return { ok: false, error: "source is required." };
  if (!contactExists(input.contactId)) return { ok: false, error: "Contact not found." };

  // One rule decides what resets the keep-in-touch clock, whoever logs it
  // (SPEC §3): an email only when the owner sent it, anything else logged.
  const countsForTouch = interactionCountsForTouch(input.kind, direction);

  if (sourceKey) {
    const existing = db
      .select({ id: interactions.id, countsForTouch: interactions.countsForTouch })
      .from(interactions)
      .where(
        and(
          eq(interactions.contactId, input.contactId),
          eq(interactions.source, input.source),
          eq(interactions.sourceKey, sourceKey)
        )
      )
      .get();
    if (existing) {
      return {
        ok: true,
        interactionId: existing.id,
        noteId: null,
        created: false,
        countsForTouch: existing.countsForTouch,
      };
    }
  }

  const now = Date.now();
  const written = db.transaction(() => {
    const row = db
      .insert(interactions)
      .values({
        contactId: input.contactId,
        kind: input.kind,
        direction,
        occurredAt: input.occurredAt,
        title,
        meta: input.meta ? JSON.stringify(input.meta) : null,
        source: input.source,
        sourceKey,
        countsForTouch,
        createdAt: now,
      })
      .returning({ id: interactions.id })
      .get();
    let noteId: number | null = null;
    if (noteMd) {
      // The interaction carries the touch; the note is dated to it so the
      // two sit together on the timeline instead of the note landing at "now".
      noteId = db
        .insert(notes)
        .values({
          contactId: input.contactId,
          bodyMd: noteMd,
          countsForTouch: false,
          createdAt: input.occurredAt,
          updatedAt: now,
        })
        .returning({ id: notes.id })
        .get().id;
      syncNoteMentions(noteId, noteMd);
    }
    return { interactionId: row.id, noteId };
  });
  recomputeContact(input.contactId);
  return { ok: true, ...written, created: true, countsForTouch };
}

export type AddNoteInput = {
  /** Null = a standalone note; its @-mentions are then its only links. */
  contactId: number | null;
  bodyMd: string;
  /** Default false: a plain note is not a touch (SPEC §3). */
  countsForTouch?: boolean;
  /** Defaults to now; a note about something past can be dated to it. */
  createdAt?: number;
};

export type AddNoteResult =
  | {
      ok: true;
      noteId: number;
      /** The note's contact and everyone it @-mentions — whose pages changed. */
      contactIds: number[];
    }
  | CoreError;

export function addNote(input: AddNoteInput): AddNoteResult {
  if (input.bodyMd.length > NOTE_BODY_MAX) return { ok: false, error: "Note is too long." };
  if (input.contactId !== null && !contactExists(input.contactId)) {
    return { ok: false, error: "Contact not found." };
  }
  const now = Date.now();
  const createdAt = input.createdAt ?? now;
  if (!Number.isInteger(createdAt) || createdAt <= 0) {
    return { ok: false, error: "createdAt must be a timestamp in milliseconds." };
  }
  const countsForTouch = input.countsForTouch ?? false;
  const noteId = db.transaction(() => {
    const id = db
      .insert(notes)
      .values({
        contactId: input.contactId,
        bodyMd: input.bodyMd,
        countsForTouch,
        createdAt,
        updatedAt: now,
      })
      .returning({ id: notes.id })
      .get().id;
    // note_mentions rows are always derived from the body.
    syncNoteMentions(id, input.bodyMd);
    return id;
  });
  const contactIds = [
    ...new Set([
      ...(input.contactId !== null ? [input.contactId] : []),
      ...mentionedContactIds(noteId),
    ]),
  ];
  // A counting note is a touch for its contact and everyone it mentions.
  if (countsForTouch) for (const id of contactIds) recomputeContact(id);
  return { ok: true, noteId, contactIds };
}

/**
 * Has the owner's agent already logged this email on this contact's
 * timeline? Rolo's own Gmail sync asks before adding a row, so that a
 * message the agent recorded first is not there twice once the sync
 * reaches it (SPEC §14) — the mirror of the agent's own check against
 * rows the sync wrote. Matches the message id the agent keyed it with
 * (`gmail:<id>`), or the same direction and subject within ten minutes.
 */
export function agentLoggedEmail(input: {
  contactId: number;
  messageId: string;
  direction: "inbound" | "outbound";
  occurredAt: number;
  title: string | null;
}): boolean {
  const rows = db
    .select({
      kind: interactions.kind,
      direction: interactions.direction,
      occurredAt: interactions.occurredAt,
      title: interactions.title,
      sourceKey: interactions.sourceKey,
    })
    .from(interactions)
    .where(
      and(
        eq(interactions.contactId, input.contactId),
        eq(interactions.source, "agent"),
        eq(interactions.kind, "email")
      )
    )
    .all();
  return rows.some(
    (r) =>
      r.sourceKey === `gmail:${input.messageId}` ||
      isSameExchange(r, {
        kind: "email",
        direction: input.direction,
        occurredAt: input.occurredAt,
        title: input.title,
      })
  );
}
