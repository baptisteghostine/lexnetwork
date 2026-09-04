import { and, asc, desc, eq, gt, inArray, isNull, lte } from "drizzle-orm";

import { db } from "@/db/client";
import {
  calendarEvents,
  contactChanges,
  contacts,
  interactions,
  notes,
  reminders,
} from "@/db/schema";
import {
  buildMeetingPrepPrompt,
  MEETING_PREP_SYSTEM,
  meetingPrepFormat,
  parseTalkingPoints,
} from "@/lib/ai/prompts";
import { getSmtpSettings, sendEmail } from "@/lib/digest/send";
import {
  ago,
  buildMeetingPrepEmail,
  clampLeadMinutes,
  interactionLabel,
  parsePrep,
  PREP_CONTACTS_MAX,
  PREP_GRACE_MS,
  PREP_INTERACTIONS_MAX,
  PREP_NOTE_CHARS,
  PREP_NOTES_MAX,
  selectEventsToPrep,
  type MeetingPrep,
  type PrepCandidate,
  type PrepContact,
} from "@/lib/prep/build";
import { getSetting } from "@/lib/settings";
import { aiEnabled, callAi } from "@/server/ai-client";
import { ownerTimezone } from "@/server/today-data";

// Pre-meeting brief (SPEC §9e). The scheduler sweeps this every 15 min
// while Google is connected; almost every sweep finds nothing inside the
// lead window and returns without touching AI or SMTP.
//
// Exactly-once is a ledger, like the network-updates email: an event is
// only ever briefed while calendar_events.prepped_at is NULL, and the
// stamp is written after the send returns. The built brief is stored in
// prep_json *before* sending, so a failed send retries without another
// round of AI calls, and Today can show the brief whether or not SMTP is
// even configured.

const AI_CONTACTS_MAX = 3; // talking points for the first few people only

export function meetingPrepEnabled(): boolean {
  return getSetting<boolean>("meeting_prep.enabled") ?? true;
}

export function meetingPrepLeadMs(): number {
  return clampLeadMinutes(getSetting<number>("meeting_prep.lead_minutes")) * 60_000;
}

export function meetingPrepEmailEnabled(): boolean {
  return getSetting<boolean>("meeting_prep.email") ?? true;
}

type StoredAttendee = { email: string; name: string | null; contactId: number | null };

function matchedIds(attendeesJson: string | null): number[] {
  try {
    const raw = JSON.parse(attendeesJson ?? "[]") as StoredAttendee[];
    return Array.isArray(raw)
      ? [...new Set(raw.map((a) => a.contactId).filter((id): id is number => typeof id === "number"))]
      : [];
  } catch {
    return [];
  }
}

async function prepContact(
  contactId: number,
  meetingSummary: string | null,
  now: number,
  withAi: boolean
): Promise<PrepContact | null> {
  const c = db.select().from(contacts).where(eq(contacts.id, contactId)).get();
  if (!c || c.archivedAt !== null) return null;

  const recent = db
    .select({
      kind: interactions.kind,
      direction: interactions.direction,
      title: interactions.title,
      occurredAt: interactions.occurredAt,
    })
    .from(interactions)
    .where(and(eq(interactions.contactId, contactId), lte(interactions.occurredAt, now)))
    .orderBy(desc(interactions.occurredAt))
    .limit(PREP_INTERACTIONS_MAX)
    .all();

  const openReminders = db
    .select({ title: reminders.title, dueAt: reminders.dueAt })
    .from(reminders)
    .where(
      and(
        eq(reminders.contactId, contactId),
        isNull(reminders.completedAt),
        isNull(reminders.rrule)
      )
    )
    .orderBy(asc(reminders.dueAt))
    .limit(3)
    .all();

  const changes = db
    .select({
      field: contactChanges.field,
      oldValue: contactChanges.oldValue,
      newValue: contactChanges.newValue,
      detectedAt: contactChanges.detectedAt,
    })
    .from(contactChanges)
    .where(and(eq(contactChanges.contactId, contactId), isNull(contactChanges.dismissedAt)))
    .orderBy(desc(contactChanges.detectedAt))
    .limit(2)
    .all();

  const ownerNotes = db
    .select({ body: notes.bodyMd })
    .from(notes)
    .where(eq(notes.contactId, contactId))
    .orderBy(desc(notes.createdAt))
    .limit(PREP_NOTES_MAX)
    .all()
    .map((n) => n.body.replace(/\s+/g, " ").trim().slice(0, PREP_NOTE_CHARS))
    .filter((b) => b !== "");

  let talkingPoints: string[] = [];
  if (withAi) {
    try {
      const result = await callAi({
        feature: "meeting_prep",
        system: MEETING_PREP_SYSTEM,
        prompt: buildMeetingPrepPrompt({
          meetingSummary,
          displayName: c.displayName,
          title: c.title,
          company: c.company,
          history: recent.map((i) => `${interactionLabel(i)} · ${ago(i.occurredAt, now)}`),
          changes,
          notes: ownerNotes,
        }),
        maxTokens: 768,
        outputFormat: meetingPrepFormat(),
      });
      if (result.ok) talkingPoints = parseTalkingPoints(result.text) ?? [];
      else console.error("[rolo-meeting-prep] AI failed:", result.error);
    } catch (err) {
      // A brief without talking points is still a brief — never let the
      // model's outage take the reminder of a meeting with it.
      console.error("[rolo-meeting-prep] AI threw:", err);
    }
  }

  return {
    contactId,
    displayName: c.displayName,
    title: c.title,
    company: c.company,
    lastInteractionAt: c.lastInteractionAt,
    interactions: recent,
    reminders: openReminders,
    changes,
    notes: ownerNotes,
    talkingPoints,
  };
}

async function buildPrep(
  event: {
    eventKey: string;
    summary: string | null;
    startsAt: number;
    endsAt: number | null;
    htmlLink: string | null;
  },
  contactIds: number[],
  now: number
): Promise<MeetingPrep> {
  const withAi = aiEnabled();
  const people: PrepContact[] = [];
  for (const [i, id] of contactIds.slice(0, PREP_CONTACTS_MAX).entries()) {
    const p = await prepContact(id, event.summary, now, withAi && i < AI_CONTACTS_MAX);
    if (p) people.push(p);
  }
  return {
    eventKey: event.eventKey,
    summary: event.summary,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    htmlLink: event.htmlLink,
    contacts: people,
    generatedAt: now,
  };
}

export type MeetingPrepResult = { prepped: number; emailed: number };

export async function runMeetingPrep(now: number): Promise<MeetingPrepResult> {
  const result: MeetingPrepResult = { prepped: 0, emailed: 0 };
  if (!meetingPrepEnabled()) return result;

  const rows = db
    .select()
    .from(calendarEvents)
    .where(
      and(
        isNull(calendarEvents.preppedAt),
        gt(calendarEvents.startsAt, now - PREP_GRACE_MS),
        lte(calendarEvents.startsAt, now + meetingPrepLeadMs())
      )
    )
    .all();
  const candidates: PrepCandidate[] = rows.map((r) => ({
    eventKey: r.eventKey,
    startsAt: r.startsAt,
    status: r.status,
    myResponse: r.myResponse,
    preppedAt: r.preppedAt,
    matchedContactIds: matchedIds(r.attendees),
  }));
  const byKey = new Map(rows.map((r) => [r.eventKey, r]));

  const email = meetingPrepEmailEnabled() && getSmtpSettings() !== null;
  const appUrl = getSetting<string>("app_url") ?? "http://localhost:3000";
  const timezone = ownerTimezone();

  for (const c of selectEventsToPrep(candidates, now, meetingPrepLeadMs())) {
    const row = byKey.get(c.eventKey)!;
    // A brief built on an earlier tick whose send failed is reused as-is.
    let prep = parsePrep(row.prepJson);
    if (!prep) {
      prep = await buildPrep(row, c.matchedContactIds, now);
      if (prep.contacts.length === 0) {
        // Everyone matched has since been archived — nothing to say, and
        // nothing to keep re-checking.
        db.update(calendarEvents)
          .set({ preppedAt: now })
          .where(eq(calendarEvents.eventKey, c.eventKey))
          .run();
        continue;
      }
      db.update(calendarEvents)
        .set({ prepJson: JSON.stringify(prep) })
        .where(eq(calendarEvents.eventKey, c.eventKey))
        .run();
    }
    if (email) {
      await sendEmail(buildMeetingPrepEmail(prep, { appUrl, timezone, now }));
      result.emailed++;
    }
    db.update(calendarEvents)
      .set({ preppedAt: Date.now() })
      .where(eq(calendarEvents.eventKey, c.eventKey))
      .run();
    result.prepped++;
  }
  return result;
}

/** Briefs for a set of events, for the Today agenda. */
export function prepsFor(eventKeys: string[]): Map<string, MeetingPrep> {
  const out = new Map<string, MeetingPrep>();
  if (eventKeys.length === 0) return out;
  const rows = db
    .select({ eventKey: calendarEvents.eventKey, prepJson: calendarEvents.prepJson })
    .from(calendarEvents)
    .where(inArray(calendarEvents.eventKey, eventKeys))
    .all();
  for (const r of rows) {
    const p = parsePrep(r.prepJson);
    if (p) out.set(r.eventKey, p);
  }
  return out;
}
