import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { contactEmails, contacts, reminders } from "@/db/schema";
import { upcomingBirthdays, type Feb29Rule, type UpcomingBirthday } from "@/lib/birthdays";
import { DAY_MS } from "@/lib/cadence/engine";
import { getSetting } from "@/lib/settings";
import { fallbackTimezone, localParts } from "@/lib/time";

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

export type TodayData = {
  timezone: string;
  reminders: DueReminder[];
  dueContacts: DueContact[];
  birthdays: UpcomingBirthday[];
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
  const birthdays = upcomingBirthdays(
    birthdayRows.map((c) => ({ ...c, hasPhoto: c.photoPath !== null })),
    { year: local.year, month: local.month, day: local.day },
    {
      windowDays: 7,
      feb29: getSetting<Feb29Rule>("birthdays.feb29") ?? "feb28",
      importantOnly: getSetting<boolean>("birthdays.important_only") ?? true,
    }
  );

  return {
    timezone,
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
