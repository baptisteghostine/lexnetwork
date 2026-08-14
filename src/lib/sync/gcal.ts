// Google Calendar sync — pure request builders and event mapping (SPEC §9).
// Initial run: bounded window (past 1y, future 60d), singleEvents=true so
// recurring events arrive as individual occurrences. Incremental: syncToken
// (which Google forbids combining with window params). 410 → caller drops
// the token and re-runs the window.

const GCAL_BASE =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export const CALENDAR_PAST_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
export const CALENDAR_FUTURE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

export function buildEventsWindowUrl(opts: {
  now: number;
  pageToken?: string;
}): string {
  const params = new URLSearchParams({
    singleEvents: "true",
    maxResults: "250",
    timeMin: new Date(opts.now - CALENDAR_PAST_WINDOW_MS).toISOString(),
    timeMax: new Date(opts.now + CALENDAR_FUTURE_WINDOW_MS).toISOString(),
  });
  if (opts.pageToken) params.set("pageToken", opts.pageToken);
  return `${GCAL_BASE}?${params.toString()}`;
}

export function buildEventsIncrementalUrl(opts: {
  syncToken: string;
  pageToken?: string;
}): string {
  const params = new URLSearchParams({ syncToken: opts.syncToken });
  if (opts.pageToken) params.set("pageToken", opts.pageToken);
  return `${GCAL_BASE}?${params.toString()}`;
}

// ---------- event mapping ----------

export type CalendarAttendee = {
  email: string;
  name: string | null;
  self: boolean;
  responseStatus: string | null;
};

export type CalendarEventParsed = {
  eventKey: string;
  summary: string | null;
  startsAt: number;
  endsAt: number | null;
  allDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  myResponse: string | null;
  attendees: CalendarAttendee[];
  htmlLink: string | null;
};

type RawEvent = {
  id?: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: {
    email?: string;
    displayName?: string;
    self?: boolean;
    responseStatus?: string;
  }[];
};

function parseWhen(w?: { dateTime?: string; date?: string }): {
  at: number | null;
  allDay: boolean;
} {
  if (w?.dateTime) return { at: Date.parse(w.dateTime), allDay: false };
  // All-day events carry a date only; parse as UTC midnight — day-level
  // precision is all the agenda needs.
  if (w?.date) return { at: Date.parse(`${w.date}T00:00:00Z`), allDay: true };
  return { at: null, allDay: false };
}

export function parseCalendarEvent(raw: unknown): CalendarEventParsed | null {
  const e = raw as RawEvent;
  if (!e?.id) return null;
  const status =
    e.status === "cancelled" || e.status === "tentative"
      ? e.status
      : "confirmed";
  const start = parseWhen(e.start);
  // Cancelled deltas from an incremental sync arrive without start/end —
  // keep them so the caller can delete the stored row.
  if (start.at === null && status !== "cancelled") return null;
  const attendees: CalendarAttendee[] = (e.attendees ?? [])
    .filter((a) => !!a.email)
    .map((a) => ({
      email: a.email!.toLowerCase(),
      name: a.displayName ?? null,
      self: a.self ?? false,
      responseStatus: a.responseStatus ?? null,
    }));
  return {
    eventKey: e.id,
    summary: e.summary ?? null,
    startsAt: start.at ?? 0,
    endsAt: parseWhen(e.end).at,
    allDay: start.allDay,
    status,
    myResponse: attendees.find((a) => a.self)?.responseStatus ?? null,
    attendees,
    htmlLink: e.htmlLink ?? null,
  };
}

type RawEventsPage = {
  items?: unknown[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

export function parseEventsPage(raw: unknown): {
  events: CalendarEventParsed[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
} {
  const page = raw as RawEventsPage;
  return {
    events: (page.items ?? [])
      .map(parseCalendarEvent)
      .filter((e): e is CalendarEventParsed => e !== null),
    nextPageToken: page.nextPageToken ?? null,
    nextSyncToken: page.nextSyncToken ?? null,
  };
}

/**
 * A past event becomes a meeting interaction (SPEC §9) when it actually
 * occurred: confirmed, not declined by the owner, and has at least one
 * non-self attendee (solo blocks are not meetings).
 */
export function eventCountsAsMeeting(
  e: CalendarEventParsed,
  now: number
): boolean {
  return (
    e.status === "confirmed" &&
    e.myResponse !== "declined" &&
    (e.endsAt ?? e.startsAt) < now &&
    e.attendees.some((a) => !a.self)
  );
}

/**
 * Same predicate over a stored `calendar_events` row. Incremental sync only
 * delivers *changed* events, so an event synced while still in the future is
 * typically never seen again — whether it has since occurred must be decided
 * from the cache on every tick, not from the delta stream. Stored attendee
 * lists exclude the owner, so "has a non-self attendee" = non-empty list
 * (checked by the caller, which holds the parsed list).
 */
export function storedEventCountsAsMeeting(
  row: { status: string; myResponse: string | null; startsAt: number; endsAt: number | null },
  now: number
): boolean {
  return (
    row.status === "confirmed" &&
    row.myResponse !== "declined" &&
    (row.endsAt ?? row.startsAt) < now
  );
}
