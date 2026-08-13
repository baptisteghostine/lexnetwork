import { and, asc, desc, inArray, isNotNull, isNull, lte } from "drizzle-orm";

import { TodayQueue, type DueItem } from "@/components/today-queue";
import { db } from "@/db/client";
import { contactEmails, contacts } from "@/db/schema";
import { DAY_MS } from "@/lib/cadence/engine";
import { requireAuth } from "@/lib/auth";
import { now as currentTime } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const now = currentTime();

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

  // One query for all primary emails (lowest priority per contact wins).
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

  const items: DueItem[] = due.map((c) => ({
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
  }));

  return (
    <div>
      <header className="flex items-center gap-3 border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">Today</h1>
        <span className="text-xs text-muted-foreground">
          {items.length} due
        </span>
      </header>
      <div className="max-w-3xl space-y-6 px-5 py-4">
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Keep in touch
          </h2>
          <TodayQueue items={items} />
        </section>
        {/* Reminders, birthdays, job changes, and the calendar agenda join
            this page in later phases (SPEC §12 section order). */}
      </div>
    </div>
  );
}
