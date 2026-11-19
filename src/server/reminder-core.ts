import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts, reminders } from "@/db/schema";
import { sanitizeRrule } from "@/lib/reminders/engine";
import { materializeNext } from "@/lib/reminders/fire";

// Creating and completing a reminder, without a session (SPEC §14,
// Phase 13). The Reminders page actions wrap these behind the cookie;
// the agent connector calls them behind its token. No revalidation here —
// the caller knows which pages it needs fresh.
//
// Never export these from a "use server" file.

export const REMINDER_TITLE_MAX = 300;
export const REMINDER_BODY_MAX = 5000;

export type CreateReminderInput = {
  title: string;
  body?: string | null;
  dueAt: number;
  /** RFC 5545 subset (SPEC §4); empty or absent = one-off. */
  rrule?: string | null;
  contactId?: number | null;
};

export type CreateReminderResult =
  | { ok: true; reminderId: number; contactId: number | null; recurring: boolean }
  | { ok: false; error: string };

export const RRULE_ERROR =
  "Recurrence must use FREQ daily/weekly/monthly/yearly with INTERVAL, BYDAY, BYMONTHDAY, UNTIL, or COUNT.";

export function createReminder(input: CreateReminderInput): CreateReminderResult {
  const title = input.title.trim();
  if (!title || title.length > REMINDER_TITLE_MAX) {
    return { ok: false, error: `A reminder needs a title of at most ${REMINDER_TITLE_MAX} characters.` };
  }
  const body = input.body?.trim() ?? "";
  if (body.length > REMINDER_BODY_MAX) return { ok: false, error: "Reminder body is too long." };
  if (!Number.isInteger(input.dueAt) || input.dueAt <= 0) {
    return { ok: false, error: "dueAt must be a timestamp in milliseconds." };
  }
  let rrule: string | null = null;
  if (input.rrule?.trim()) {
    rrule = sanitizeRrule(input.rrule.trim());
    if (rrule === null) return { ok: false, error: RRULE_ERROR };
  }
  const contactId = input.contactId ?? null;
  if (
    contactId !== null &&
    !db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).get()
  ) {
    return { ok: false, error: "Contact not found." };
  }

  const now = Date.now();
  const reminderId = db.transaction(() => {
    const row = db
      .insert(reminders)
      .values({
        contactId,
        title,
        body: body || null,
        dueAt: input.dueAt,
        rrule,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: reminders.id })
      .get();
    // A recurring definer never fires itself — materialize the first
    // occurrence (dueAt inclusive) as its own row.
    if (rrule !== null) materializeNext(row.id, input.dueAt - 1);
    return row.id;
  });
  return { ok: true, reminderId, contactId, recurring: rrule !== null };
}

export type CompleteReminderResult =
  | { ok: true; contactId: number | null; changed: boolean }
  | { ok: false; error: string };

/** `changed` is false when it was already complete — a repeat is a no-op. */
export function completeReminder(id: number): CompleteReminderResult {
  const r = db.select().from(reminders).where(eq(reminders.id, id)).get();
  if (!r) return { ok: false, error: "Reminder not found." };
  if (r.completedAt !== null) return { ok: true, contactId: r.contactId, changed: false };
  const now = Date.now();
  db.transaction(() => {
    db.update(reminders)
      .set({ completedAt: now, updatedAt: now })
      .where(eq(reminders.id, id))
      .run();
    // SPEC §4 AC: completing a recurring occurrence immediately shows the
    // next due date.
    if (r.seriesId !== null) materializeNext(r.seriesId, r.dueAt);
  });
  return { ok: true, contactId: r.contactId, changed: true };
}
