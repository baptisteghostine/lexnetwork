"use server";

import { eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { calendarEvents, contacts, notes, reminders } from "@/db/schema";
import {
  attendeeMentions,
  buildFollowupPrompt,
  FOLLOWUP_SYSTEM,
  followupFormat,
  meetingEnd,
  parseFollowup,
} from "@/lib/ai/followup";
import { requireAuth } from "@/lib/auth";
import { DAY_MS } from "@/lib/cadence/engine";
import { aiConfig, aiEnabled, callAi } from "@/server/ai-client";
import { upsertAnnotation } from "@/server/ai-annotations";
import { recomputeNoteContacts, syncNoteMentions } from "@/server/note-sync";
import { ownerTimezone } from "@/server/today-data";

// Post-meeting follow-up (SPEC §9e/§11, 2026-09-26): the owner's one
// line becomes a note on the first attendee (mentioning the others) and
// the reminders it implies. The model tidies and extracts; when it fails,
// the owner's words are still saved verbatim — capture never depends on
// the model being up. The meeting_followup annotation is the ledger that
// stops the card from asking twice.

type StoredAttendee = { email: string; name: string | null; contactId: number | null };

function attendeeContacts(attendeesJson: string | null) {
  let ids: number[] = [];
  try {
    const raw = JSON.parse(attendeesJson ?? "[]") as StoredAttendee[];
    ids = [...new Set(raw.map((a) => a.contactId).filter((id): id is number => typeof id === "number"))];
  } catch {
    ids = [];
  }
  if (ids.length === 0) return [];
  return db
    .select({ contactId: contacts.id, name: contacts.displayName, title: contacts.title, company: contacts.company })
    .from(contacts)
    .where(inArray(contacts.id, ids))
    .all();
}

const captureInput = z.object({
  eventId: z.number().int().positive(),
  text: z.string().trim().min(2).max(4000),
});

export async function captureFollowupAction(input: {
  eventId: number;
  text: string;
}): Promise<{ error?: string; noteId?: number; reminders?: number }> {
  await requireAuth();
  const parsed = captureInput.safeParse(input);
  if (!parsed.success) return { error: "Write a line about how it went." };
  const event = db.select().from(calendarEvents).where(eq(calendarEvents.id, parsed.data.eventId)).get();
  if (!event) return { error: "Meeting not found." };
  const people = attendeeContacts(event.attendees);
  if (people.length === 0) return { error: "Nobody in Rolo was at this meeting." };
  const now = Date.now();
  const endedAt = meetingEnd(event);
  const attendeeIds = new Set(people.map((p) => p.contactId));

  // The model's tidy-up, or the owner's words as typed.
  let noteMd = parsed.data.text.trim();
  let extracted: { title: string; dueInDays: number; contactId: number | null }[] = [];
  let callId: number | null = null;
  if (aiEnabled()) {
    const result = await callAi({
      feature: "followup",
      system: FOLLOWUP_SYSTEM,
      prompt: buildFollowupPrompt({
        meetingSummary: event.summary,
        meetingDate: new Intl.DateTimeFormat("en-GB", {
          timeZone: ownerTimezone(),
          month: "short",
          day: "numeric",
        }).format(event.startsAt),
        contacts: people,
        answer: parsed.data.text,
      }),
      maxTokens: 1200,
      outputFormat: followupFormat(),
    });
    callId = result.callId;
    const out = result.ok ? parseFollowup(result.text, attendeeIds) : null;
    if (out) {
      noteMd = out.noteMd;
      extracted = out.reminders;
    } else if (!result.ok) {
      console.error("[rolo-followup] AI failed, saving verbatim:", result.error);
    }
  }

  const primary = people[0];
  const body = `${noteMd}${attendeeMentions(people, primary.contactId)}`;
  const created = db.transaction(() => {
    const note = db
      .insert(notes)
      .values({
        contactId: primary.contactId,
        bodyMd: body,
        // The meeting itself already counted as a touch; the note is
        // dated to the meeting so the two sit together on the timeline.
        countsForTouch: false,
        createdAt: endedAt,
        updatedAt: now,
      })
      .returning({ id: notes.id })
      .get();
    syncNoteMentions(note.id, body);
    const reminderIds: number[] = [];
    for (const r of extracted) {
      const row = db
        .insert(reminders)
        .values({
          contactId: r.contactId ?? primary.contactId,
          title: r.title,
          body: null,
          dueAt: now + r.dueInDays * DAY_MS,
          rrule: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: reminders.id })
        .get();
      reminderIds.push(row.id);
    }
    return { noteId: note.id, reminderIds };
  });
  upsertAnnotation(
    "meeting_followup",
    event.id,
    { status: "captured", noteId: created.noteId, reminderIds: created.reminderIds, capturedAt: now },
    aiConfig()?.model ?? "none",
    callId
  );
  recomputeNoteContacts(people.map((p) => p.contactId));
  revalidatePath("/today");
  revalidatePath("/reminders");
  return { noteId: created.noteId, reminders: created.reminderIds.length };
}

export async function skipFollowupAction(input: { eventId: number }): Promise<void> {
  await requireAuth();
  const event = db.select({ id: calendarEvents.id }).from(calendarEvents).where(eq(calendarEvents.id, input.eventId)).get();
  if (!event) return;
  upsertAnnotation("meeting_followup", event.id, { status: "skipped", skippedAt: Date.now() }, "none", null);
  revalidatePath("/today");
}
