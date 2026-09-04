import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  calendarEvents,
  contactChanges,
  contactEmails,
  contacts,
  interactions,
  reminders,
} from "@/db/schema";
import { upcomingBirthdays, type Feb29Rule, type UpcomingBirthday } from "@/lib/birthdays";
import { parsePrep, type MeetingPrep } from "@/lib/prep/build";
import { DAY_MS } from "@/lib/cadence/engine";
import { getSetting } from "@/lib/settings";
import { fallbackTimezone, fromFakeUtc, localParts } from "@/lib/time";

// The one source of truth for "what is due right now" — the Today page
// and the digest email both render exactly this (SPEC §3 digest AC).
// NOTE: no "server-only" import here; the scheduler consumes this module
// outside a request context.

export type DueReminder = {
  id: number;
  title: string;
  body: string | null;
  dueAt: number;
  fired: boolean;
  isRecurring: boolean;
  contactId: number | null;
  contactName: string | null;
  contactHasPhoto: boolean;
};

export type DueContact = {
  contactId: number;
  displayName: string;
  company: string | null;
  title: string | null;
  starred: boolean;
  hasPhoto: boolean;
  daysOverdue: number;
  primaryEmail: string | null;
};

export type OpenChange = {
  id: number;
  contactId: number;
  contactName: string;
  contactHasPhoto: boolean;
  field: "company" | "title";
  oldValue: string | null;
  newValue: string | null;
  detectedAt: number;
};

export type AgendaAttendee = {
  email: string;
  name: string | null;
  contactId: number | null;
};

export type AgendaItem = {
  eventKey: string;
  summary: string | null;
  startsAt: number;
  endsAt: number | null;
  allDay: boolean;
  htmlLink: string | null;
  attendees: AgendaAttendee[];
  /** The pre-meeting brief (SPEC §9e), once the job has built one. */
  prep: MeetingPrep | null;
};

export type TodayData = {
  timezone: string;
  reminders: DueReminder[];
  dueContacts: DueContact[];
  changes: OpenChange[];
  birthdays: UpcomingBirthday[];
  agenda: AgendaItem[];
};

export function ownerTimezone(): string {
  return getSetting<string>("timezone") ?? fallbackTimezone();
}

export function getTodayData(now: number): TodayData {
  const timezone = ownerTimezone();

  // (1) Reminders due: occurrences + one-offs past their effective due.
  const reminderRows = db
    .select({
      id: reminders.id,
      title: reminders.title,
      body: reminders.body,
      dueAt: reminders.dueAt,
      firedAt: reminders.firedAt,
      seriesId: reminders.seriesId,
      contactId: reminders.contactId,
      contactName: contacts.displayName,
      contactPhoto: contacts.photoPath,
    })
    .from(reminders)
    .leftJoin(contacts, eq(contacts.id, reminders.contactId))
    .where(
      and(
        isNull(reminders.rrule),
        isNull(reminders.completedAt),
        sql`COALESCE(${reminders.snoozedUntil}, ${reminders.dueAt}) <= ${now}`
      )
    )
    .orderBy(asc(reminders.dueAt))
    .all();

  // (2) Keep-in-touch due: starred first, then most overdue.
  const due = db
    .select()
    .from(contacts)
    .where(
      and(
        isNull(contacts.archivedAt),
        isNotNull(contacts.cadenceDays),
        isNotNull(contacts.nextTouchAt),
        lte(contacts.nextTouchAt, now)
      )
    )
    .orderBy(desc(contacts.starred), asc(contacts.nextTouchAt))
    .all();

  const primaryEmails = new Map<number, string>();
  if (due.length > 0) {
    const emailRows = db
      .select({
        contactId: contactEmails.contactId,
        email: contactEmails.email,
      })
      .from(contactEmails)
      .where(
        inArray(
          contactEmails.contactId,
          due.map((c) => c.id)
        )
      )
      .orderBy(asc(contactEmails.priority))
      .all();
    for (const e of emailRows) {
      if (!primaryEmails.has(e.contactId)) {
        primaryEmails.set(e.contactId, e.email);
      }
    }
  }

  // (3) Job changes — open "reason to reach out" cards (SPEC §5). UI
  // collapses to the latest change per contact+field; company changes
  // rank above title-only ones.
  const changeRows = db
    .select({
      id: contactChanges.id,
      contactId: contactChanges.contactId,
      field: contactChanges.field,
      oldValue: contactChanges.oldValue,
      newValue: contactChanges.newValue,
      detectedAt: contactChanges.detectedAt,
      contactName: contacts.displayName,
      photoPath: contacts.photoPath,
      archivedAt: contacts.archivedAt,
    })
    .from(contactChanges)
    .innerJoin(contacts, eq(contacts.id, contactChanges.contactId))
    .where(
      and(
        isNull(contactChanges.dismissedAt),
        isNull(contactChanges.actedAt),
        isNull(contacts.archivedAt)
      )
    )
    .orderBy(desc(contactChanges.detectedAt))
    .all();
  const latestPerField = new Map<string, (typeof changeRows)[number]>();
  for (const r of changeRows) {
    const key = `${r.contactId}:${r.field}`;
    if (!latestPerField.has(key)) latestPerField.set(key, r);
  }
  const changes: OpenChange[] = [...latestPerField.values()]
    .sort(
      (a, b) =>
        Number(b.field === "company") - Number(a.field === "company") ||
        b.detectedAt - a.detectedAt
    )
    .map((r) => ({
      id: r.id,
      contactId: r.contactId,
      contactName: r.contactName,
      contactHasPhoto: r.photoPath !== null,
      field: r.field as "company" | "title",
      oldValue: r.oldValue,
      newValue: r.newValue,
      detectedAt: r.detectedAt,
    }));

  // (4) Birthdays this week.
  const birthdayRows = db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      birthdayMonth: contacts.birthdayMonth,
      birthdayDay: contacts.birthdayDay,
      birthdayYear: contacts.birthdayYear,
      starred: contacts.starred,
      lastInteractionAt: contacts.lastInteractionAt,
      photoPath: contacts.photoPath,
    })
    .from(contacts)
    .where(and(isNull(contacts.archivedAt), isNotNull(contacts.birthdayMonth)))
    .all();

  const local = localParts(timezone, now);
  // SPEC §6 "important only": ≥1 recorded interaction ever, of ANY kind —
  // last_interaction_at alone misses inbound-only correspondents.
  const everInteracted = new Set(
    db
      .selectDistinct({ contactId: interactions.contactId })
      .from(interactions)
      .all()
      .map((r) => r.contactId)
  );
  const birthdays = upcomingBirthdays(
    birthdayRows.map((c) => ({
      ...c,
      hasInteraction: everInteracted.has(c.id),
      hasPhoto: c.photoPath !== null,
    })),
    { year: local.year, month: local.month, day: local.day },
    {
      windowDays: 7,
      feb29: getSetting<Feb29Rule>("birthdays.feb29") ?? "feb28",
      importantOnly: getSetting<boolean>("birthdays.important_only") ?? true,
    }
  );

  // (5) Today's calendar agenda (SPEC §9): synced events overlapping the
  // owner's local day, declined ones excluded. Day bounds come from the
  // local calendar date mapped back per-instant (fromFakeUtc), so DST
  // transition days keep their real 23/25-hour shape instead of shifting
  // the window by an hour.
  const dayStart = fromFakeUtc(
    timezone,
    Date.UTC(local.year, local.month - 1, local.day)
  );
  const dayEnd = fromFakeUtc(
    timezone,
    Date.UTC(local.year, local.month - 1, local.day + 1)
  );
  const agenda: AgendaItem[] = db
    .select()
    .from(calendarEvents)
    .where(
      and(
        sql`${calendarEvents.startsAt} < ${dayEnd}`,
        sql`COALESCE(${calendarEvents.endsAt}, ${calendarEvents.startsAt}) >= ${dayStart}`
      )
    )
    .orderBy(asc(calendarEvents.startsAt))
    .all()
    .filter((e) => e.myResponse !== "declined")
    .map((e) => {
      let attendees: AgendaAttendee[] = [];
      try {
        const parsed = JSON.parse(e.attendees ?? "[]") as AgendaAttendee[];
        if (Array.isArray(parsed)) attendees = parsed;
      } catch {
        // tolerate junk — agenda still renders
      }
      return {
        eventKey: e.eventKey,
        summary: e.summary,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        allDay: e.allDay,
        htmlLink: e.htmlLink,
        attendees,
        prep: parsePrep(e.prepJson),
      };
    });

  return {
    timezone,
    agenda,
    reminders: reminderRows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      dueAt: r.dueAt,
      fired: r.firedAt !== null,
      isRecurring: r.seriesId !== null,
      contactId: r.contactId,
      contactName: r.contactName ?? null,
      contactHasPhoto: r.contactPhoto !== null && r.contactPhoto !== undefined,
    })),
    changes,
    dueContacts: due.map((c) => ({
      contactId: c.id,
      displayName: c.displayName,
      company: c.company,
      title: c.title,
      starred: c.starred,
      hasPhoto: c.photoPath !== null,
      daysOverdue: Math.max(
        0,
        Math.floor((now - (c.nextTouchAt as number)) / DAY_MS)
      ),
      primaryEmail: primaryEmails.get(c.id) ?? null,
    })),
    birthdays,
  };
}
