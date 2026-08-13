import Link from "next/link";
import { Cake, Star } from "lucide-react";

import { ContactAvatar } from "@/components/contact-avatar";
import { TodayAgenda } from "@/components/today-agenda";
import { TodayChanges } from "@/components/today-changes";
import { TodayQueue, type DueItem } from "@/components/today-queue";
import { TodayReminders } from "@/components/today-reminders";
import { requireAuth } from "@/lib/auth";
import { now as currentTime } from "@/lib/time";
import { getTodayData } from "@/server/today-data";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const now = currentTime();
  const data = getTodayData(now);

  const items: DueItem[] = data.dueContacts.map((c) => ({
    contactId: c.contactId,
    displayName: c.displayName,
    company: c.company,
    title: c.title,
    starred: c.starred,
    hasPhoto: c.hasPhoto,
    daysOverdue: c.daysOverdue,
    primaryEmail: c.primaryEmail,
  }));

  const counts = [
    data.reminders.length > 0 &&
      `${data.reminders.length} reminder${data.reminders.length > 1 ? "s" : ""}`,
    `${items.length} due`,
    data.changes.length > 0 &&
      `${data.changes.length} job change${data.changes.length > 1 ? "s" : ""}`,
    data.birthdays.length > 0 &&
      `${data.birthdays.length} birthday${data.birthdays.length > 1 ? "s" : ""}`,
    data.agenda.length > 0 &&
      `${data.agenda.length} meeting${data.agenda.length > 1 ? "s" : ""}`,
  ].filter(Boolean);

  return (
    <div>
      <header className="flex items-center gap-3 border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">Today</h1>
        <span className="text-xs text-muted-foreground">
          {counts.join(" · ")}
        </span>
      </header>
      <div className="max-w-3xl space-y-6 px-5 py-4">
        {/* SPEC §12 section order: reminders → keep-in-touch → job changes
            (Phase 7) → birthdays → calendar agenda (Phase 8). */}
        {data.reminders.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Reminders
            </h2>
            <TodayReminders items={data.reminders} now={now} />
          </section>
        )}
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Keep in touch
          </h2>
          <TodayQueue items={items} />
        </section>
        {data.changes.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Network updates
            </h2>
            <TodayChanges items={data.changes} />
          </section>
        )}
        {data.birthdays.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Birthdays this week
            </h2>
            <ol className="space-y-1">
              {data.birthdays.map((b) => (
                <li key={b.contactId}>
                  <Link
                    href={`/contacts/${b.contactId}`}
                    className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2 transition-colors hover:bg-accent/50"
                  >
                    <Cake className="size-3.5 shrink-0 text-primary" />
                    <ContactAvatar
                      contactId={b.contactId}
                      name={b.displayName}
                      hasPhoto={b.hasPhoto}
                      size="sm"
                    />
                    <span className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                      {b.displayName}
                      {b.starred ? (
                        <Star className="size-3 shrink-0 fill-warning text-warning" />
                      ) : null}
                    </span>
                    {b.turns !== null ? (
                      <span className="text-[11px] text-muted-foreground">
                        turns {b.turns}
                      </span>
                    ) : null}
                    <span className="flex-1" />
                    <span className="text-[11px] text-muted-foreground">
                      {b.daysUntil === 0
                        ? "today 🎂"
                        : b.daysUntil === 1
                          ? "tomorrow"
                          : `in ${b.daysUntil} days`}
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          </section>
        )}
        {data.agenda.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Today&apos;s agenda
            </h2>
            <TodayAgenda items={data.agenda} timezone={data.timezone} />
          </section>
        )}
      </div>
    </div>
  );
}
