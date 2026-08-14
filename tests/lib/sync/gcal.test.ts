import { describe, expect, it } from "vitest";

import {
  buildEventsIncrementalUrl,
  buildEventsWindowUrl,
  eventCountsAsMeeting,
  parseCalendarEvent,
  parseEventsPage,
  storedEventCountsAsMeeting,
  type CalendarEventParsed,
} from "../../../src/lib/sync/gcal";

const NOW = Date.parse("2026-08-13T12:00:00Z");

describe("calendar request builders", () => {
  it("window request bounds past 1y / future 60d with singleEvents", () => {
    const url = new URL(buildEventsWindowUrl({ now: NOW }));
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("timeMin")).toBe("2025-08-13T12:00:00.000Z");
    expect(url.searchParams.get("timeMax")).toBe("2026-10-12T12:00:00.000Z");
  });

  it("incremental request carries only the syncToken (Google forbids mixing)", () => {
    const url = new URL(buildEventsIncrementalUrl({ syncToken: "tok" }));
    expect(url.searchParams.get("syncToken")).toBe("tok");
    expect(url.searchParams.has("timeMin")).toBe(false);
    expect(url.searchParams.has("timeMax")).toBe(false);
  });
});

describe("parseCalendarEvent", () => {
  it("parses a timed event with attendees and my response", () => {
    const e = parseCalendarEvent({
      id: "evt1",
      status: "confirmed",
      summary: "Catch-up",
      htmlLink: "https://calendar.google.com/event?eid=x",
      start: { dateTime: "2026-08-12T09:00:00+02:00" },
      end: { dateTime: "2026-08-12T09:30:00+02:00" },
      attendees: [
        { email: "Owner@Gmail.com", self: true, responseStatus: "accepted" },
        { email: "ana@x.io", displayName: "Ana", responseStatus: "accepted" },
      ],
    })!;
    expect(e.eventKey).toBe("evt1");
    expect(e.startsAt).toBe(Date.parse("2026-08-12T07:00:00Z"));
    expect(e.myResponse).toBe("accepted");
    expect(e.attendees.map((a) => a.email)).toEqual(["owner@gmail.com", "ana@x.io"]);
  });

  it("parses all-day events at day precision", () => {
    const e = parseCalendarEvent({
      id: "evt2",
      start: { date: "2026-08-13" },
      end: { date: "2026-08-14" },
    })!;
    expect(e.allDay).toBe(true);
    expect(e.startsAt).toBe(Date.parse("2026-08-13T00:00:00Z"));
  });

  it("keeps cancelled deltas that have no start (incremental deletes)", () => {
    const e = parseCalendarEvent({ id: "evt3", status: "cancelled" })!;
    expect(e.status).toBe("cancelled");
  });

  it("drops idless or startless non-cancelled items", () => {
    expect(parseCalendarEvent({ status: "confirmed" })).toBeNull();
    expect(parseCalendarEvent({ id: "x", status: "confirmed" })).toBeNull();
  });
});

describe("eventCountsAsMeeting (SPEC §9)", () => {
  const base: CalendarEventParsed = {
    eventKey: "e",
    summary: "s",
    startsAt: NOW - 2 * 3600_000,
    endsAt: NOW - 3600_000,
    allDay: false,
    status: "confirmed",
    myResponse: "accepted",
    attendees: [
      { email: "me@x.io", name: null, self: true, responseStatus: "accepted" },
      { email: "ana@x.io", name: "Ana", self: false, responseStatus: "accepted" },
    ],
    htmlLink: null,
  };

  it("past confirmed meeting with another attendee counts", () => {
    expect(eventCountsAsMeeting(base, NOW)).toBe(true);
  });
  it("a meeting I declined does not count", () => {
    expect(eventCountsAsMeeting({ ...base, myResponse: "declined" }, NOW)).toBe(false);
  });
  it("future meetings do not count yet", () => {
    expect(
      eventCountsAsMeeting(
        { ...base, startsAt: NOW + 3600_000, endsAt: NOW + 7200_000 },
        NOW
      )
    ).toBe(false);
  });
  it("solo calendar blocks do not count", () => {
    expect(
      eventCountsAsMeeting(
        { ...base, attendees: base.attendees.filter((a) => a.self) },
        NOW
      )
    ).toBe(false);
  });
  it("tentative events do not count", () => {
    expect(eventCountsAsMeeting({ ...base, status: "tentative" }, NOW)).toBe(false);
  });
});

describe("parseEventsPage", () => {
  it("returns events plus paging tokens", () => {
    const page = parseEventsPage({
      items: [
        { id: "a", start: { dateTime: "2026-08-12T09:00:00Z" } },
        { notAnEvent: true },
      ],
      nextPageToken: "npt",
    });
    expect(page.events.map((e) => e.eventKey)).toEqual(["a"]);
    expect(page.nextPageToken).toBe("npt");
    expect(page.nextSyncToken).toBeNull();
  });

  it("surfaces the nextSyncToken from the final page", () => {
    const page = parseEventsPage({ items: [], nextSyncToken: "sync-tok" });
    expect(page.nextSyncToken).toBe("sync-tok");
  });
});

describe("storedEventCountsAsMeeting", () => {
  const stored = {
    status: "confirmed",
    myResponse: "accepted" as string | null,
    startsAt: NOW - 2 * 60 * 60 * 1000,
    endsAt: NOW - 60 * 60 * 1000,
  };
  it("an elapsed confirmed event counts", () => {
    expect(storedEventCountsAsMeeting(stored, NOW)).toBe(true);
  });
  it("an event synced while future counts once it has elapsed", () => {
    const before = stored.startsAt - 60 * 60 * 1000;
    expect(storedEventCountsAsMeeting(stored, before)).toBe(false);
    expect(storedEventCountsAsMeeting(stored, NOW)).toBe(true);
  });
  it("declined and tentative events never count", () => {
    expect(storedEventCountsAsMeeting({ ...stored, myResponse: "declined" }, NOW)).toBe(false);
    expect(storedEventCountsAsMeeting({ ...stored, status: "tentative" }, NOW)).toBe(false);
  });
  it("an event rescheduled into the future stops counting", () => {
    const future = {
      ...stored,
      startsAt: NOW + 60 * 60 * 1000,
      endsAt: NOW + 2 * 60 * 60 * 1000,
    };
    expect(storedEventCountsAsMeeting(future, NOW)).toBe(false);
  });
  it("falls back to startsAt when endsAt is null", () => {
    expect(storedEventCountsAsMeeting({ ...stored, endsAt: null }, NOW)).toBe(true);
    expect(
      storedEventCountsAsMeeting(
        { ...stored, startsAt: NOW + 1000, endsAt: null },
        NOW
      )
    ).toBe(false);
  });
});
