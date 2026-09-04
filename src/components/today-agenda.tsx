import Link from "next/link";
import { Bell, Briefcase, FileText } from "lucide-react";

import { ContactAvatar } from "@/components/contact-avatar";
import { TalkingPoints } from "@/components/talking-points";
import { ago, interactionLabel, type PrepContact } from "@/lib/prep/build";
import type { AgendaItem } from "@/server/today-data";

// Today's calendar agenda (SPEC §9/§12): synced events with matched
// contacts linked to their profiles, and — once the meeting_prep job has
// run for an event (SPEC §9e) — the brief inline under it. Server
// component; the only client piece is the copy button on talking points.

function timeRange(item: AgendaItem, timezone: string): string {
  if (item.allDay) return "All day";
  const fmt = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });
  const start = fmt.format(item.startsAt);
  return item.endsAt ? `${start}–${fmt.format(item.endsAt)}` : start;
}

function PrepBlock({ person, now }: { person: PrepContact; now: number }) {
  const role = [person.title, person.company].filter(Boolean).join(", ");
  return (
    <div className="space-y-1.5 rounded-md border border-border/60 bg-accent/20 px-3 py-2">
      <p className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
        <Link href={`/contacts/${person.contactId}`} className="font-medium hover:underline">
          {person.displayName}
        </Link>
        {role ? <span className="text-muted-foreground">{role}</span> : null}
        <span className="text-muted-foreground">
          · {person.lastInteractionAt ? `last spoke ${ago(person.lastInteractionAt, now)}` : "no recorded contact yet"}
        </span>
      </p>
      {(person.interactions.length > 0 || person.reminders.length > 0 || person.changes.length > 0) && (
        <ul className="space-y-0.5 text-[12px]">
          {person.changes.map((c, i) => (
            <li key={`c${i}`} className="flex items-center gap-1.5">
              <Briefcase className="size-3 shrink-0 text-primary" />
              {c.oldValue ? (
                <span className="text-muted-foreground line-through">{c.oldValue}</span>
              ) : null}
              <span className="font-medium text-success">{c.newValue ?? "—"}</span>
              <span className="text-[10px] uppercase text-muted-foreground">{c.field}</span>
              <span className="text-muted-foreground">· {ago(c.detectedAt, now)}</span>
            </li>
          ))}
          {person.reminders.map((r, i) => (
            <li key={`r${i}`} className="flex items-center gap-1.5">
              <Bell className="size-3 shrink-0 text-primary" />
              <span>{r.title}</span>
            </li>
          ))}
          {person.interactions.map((x, i) => (
            <li key={`i${i}`} className="text-muted-foreground">
              {interactionLabel(x)} · {ago(x.occurredAt, now)}
            </li>
          ))}
        </ul>
      )}
      {person.notes.length > 0 && (
        <ul className="space-y-0.5">
          {person.notes.map((n, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[12px]">
              <FileText className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
              <span className="line-clamp-2">{n}</span>
            </li>
          ))}
        </ul>
      )}
      <TalkingPoints points={person.talkingPoints} />
    </div>
  );
}

export function TodayAgenda({
  items,
  timezone,
  now,
}: {
  items: AgendaItem[];
  timezone: string;
  now: number;
}) {
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {items.map((item) => (
        <li key={item.eventKey} className="flex items-start gap-3 px-3 py-2">
          <span className="w-24 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
            {timeRange(item, timezone)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px]">
              {item.htmlLink ? (
                <a
                  href={item.htmlLink}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  {item.summary ?? "(no title)"}
                </a>
              ) : (
                (item.summary ?? "(no title)")
              )}
            </p>
            {item.attendees.length > 0 && (
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                {item.attendees.slice(0, 6).map((a) =>
                  a.contactId !== null ? (
                    <Link
                      key={a.email}
                      href={`/contacts/${a.contactId}`}
                      className="inline-flex items-center gap-1 text-foreground hover:underline"
                    >
                      <ContactAvatar
                        contactId={a.contactId}
                        name={a.name ?? a.email}
                        hasPhoto={false}
                        size="sm"
                      />
                      {a.name ?? a.email}
                    </Link>
                  ) : (
                    <span key={a.email}>{a.name ?? a.email}</span>
                  )
                )}
                {item.attendees.length > 6 && (
                  <span>+{item.attendees.length - 6} more</span>
                )}
              </p>
            )}
            {item.prep && item.prep.contacts.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {item.prep.contacts.map((p) => (
                  <PrepBlock key={p.contactId} person={p} now={now} />
                ))}
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
