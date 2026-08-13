import Link from "next/link";

import { ContactAvatar } from "@/components/contact-avatar";
import type { AgendaItem } from "@/server/today-data";

// Today's calendar agenda (SPEC §9/§12): synced events with matched
// contacts linked to their profiles. Server component — no interaction
// beyond navigation.

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

export function TodayAgenda({
  items,
  timezone,
}: {
  items: AgendaItem[];
  timezone: string;
}) {
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {items.map((item) => (
        <li key={item.eventKey} className="flex items-center gap-3 px-3 py-2">
          <span className="w-24 shrink-0 text-xs tabular-nums text-muted-foreground">
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
          </div>
        </li>
      ))}
    </ul>
  );
}
