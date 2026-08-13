import "server-only";

import { eq, isNotNull } from "drizzle-orm";

import { db } from "@/db/client";
import {
  calendarEvents,
  contactEmails,
  integrationAccounts,
  interactions,
  syncRuns,
} from "@/db/schema";
import { recomputeContact } from "@/lib/cadence/recompute";
import { normalizeEmail } from "@/lib/contacts/normalize";
import { outboundFetch } from "@/lib/net/fetch";
import {
  buildEventsIncrementalUrl,
  buildEventsWindowUrl,
  eventCountsAsMeeting,
  parseEventsPage,
  type CalendarEventParsed,
} from "@/lib/sync/gcal";
import {
  accessTokenFor,
  getAccount,
  markAccountError,
} from "@/server/sync/accounts";

// Calendar sync engine (SPEC §9): bounded window first, then syncToken
// increments; 410 invalidates the token and re-runs the window. Past
// events with matched attendees become meeting interactions; the stored
// event rows feed the Today agenda.

export type CalendarSyncStats = {
  eventsSeen: number;
  meetingsAdded: number;
  contactsTouched: number;
  fullWindow: boolean;
};

class CalendarApiError extends Error {
  constructor(
    public status: number,
    body: string
  ) {
    super(`Calendar API ${status}: ${body.slice(0, 300)}`);
  }
}

async function gcalJson(url: string, token: string): Promise<unknown> {
  const res = await outboundFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new CalendarApiError(res.status, await res.text());
  return res.json();
}

function matchAttendees(
  e: CalendarEventParsed
): { email: string; name: string | null; contactId: number | null }[] {
  return e.attendees
    .filter((a) => !a.self)
    .map((a) => {
      const hit = db
        .select({ contactId: contactEmails.contactId })
        .from(contactEmails)
        .where(eq(contactEmails.emailNormalized, normalizeEmail(a.email)))
        .get();
      return { email: a.email, name: a.name, contactId: hit?.contactId ?? null };
    });
}

function upsertEvent(
  accountId: number,
  e: CalendarEventParsed,
  matched: { email: string; name: string | null; contactId: number | null }[],
  now: number
): void {
  if (e.status === "cancelled") {
    db.delete(calendarEvents).where(eq(calendarEvents.eventKey, e.eventKey)).run();
    return;
  }
  db.insert(calendarEvents)
    .values({
      eventKey: e.eventKey,
      accountId,
      summary: e.summary,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      allDay: e.allDay,
      status: e.status,
      myResponse: e.myResponse,
      attendees: JSON.stringify(matched),
      htmlLink: e.htmlLink,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: calendarEvents.eventKey,
      set: {
        summary: e.summary,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        allDay: e.allDay,
        status: e.status,
        myResponse: e.myResponse,
        attendees: JSON.stringify(matched),
        htmlLink: e.htmlLink,
        updatedAt: now,
      },
    })
    .run();
}

/** One sync tick. Returns null when no active Google account exists. */
export async function runCalendarSync(): Promise<CalendarSyncStats | null> {
  const account = getAccount("google");
  if (!account || account.status === "revoked") return null;
  const token = await accessTokenFor(account);
  const now = Date.now();

  const stats: CalendarSyncStats = {
    eventsSeen: 0,
    meetingsAdded: 0,
    contactsTouched: 0,
    fullWindow: !account.calendarSyncToken,
  };
  const touched = new Set<number>();

  const runId = db
    .insert(syncRuns)
    .values({
      kind: "calendar",
      status: "running",
      cursorBefore: account.calendarSyncToken,
      startedAt: now,
    })
    .returning({ id: syncRuns.id })
    .get().id;

  try {
    let syncToken = account.calendarSyncToken;
    let nextSyncToken: string | null = null;
    let pageToken: string | undefined;

    const consumePages = async (incremental: boolean): Promise<void> => {
      do {
        const url = incremental
          ? buildEventsIncrementalUrl({ syncToken: syncToken!, pageToken })
          : buildEventsWindowUrl({ now, pageToken });
        const page = parseEventsPage(await gcalJson(url, token));
        for (const e of page.events) {
          stats.eventsSeen++;
          const matched = matchAttendees(e);
          upsertEvent(account.id, e, matched, now);
          if (eventCountsAsMeeting(e, now)) {
            for (const m of matched) {
              if (m.contactId === null) continue;
              const res = db
                .insert(interactions)
                .values({
                  contactId: m.contactId,
                  kind: "meeting",
                  direction: null,
                  occurredAt: e.startsAt,
                  title: e.summary,
                  meta: JSON.stringify({ eventId: e.eventKey }),
                  source: "calendar",
                  sourceKey: e.eventKey,
                  countsForTouch: true,
                  createdAt: Date.now(),
                })
                .onConflictDoUpdate({
                  target: [
                    interactions.contactId,
                    interactions.source,
                    interactions.sourceKey,
                  ],
                  // Partial unique index — the target must repeat its WHERE.
                  targetWhere: isNotNull(interactions.sourceKey),
                  // Rescheduled events keep one row with fresh timing.
                  set: { occurredAt: e.startsAt, title: e.summary },
                })
                .run();
              if (res.changes > 0) {
                stats.meetingsAdded++;
                touched.add(m.contactId);
              }
            }
          }
        }
        pageToken = page.nextPageToken ?? undefined;
        if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
      } while (pageToken);
    };

    if (syncToken) {
      try {
        await consumePages(true);
      } catch (err) {
        // Invalidated syncToken (SPEC §9 edge case): Google 410s. Drop
        // the cursor and re-run the bounded window; event-key upserts
        // keep it idempotent.
        if (err instanceof CalendarApiError && err.status === 410) {
          syncToken = null;
          pageToken = undefined;
          stats.fullWindow = true;
          await consumePages(false);
        } else {
          throw err;
        }
      }
    } else {
      await consumePages(false);
    }

    for (const id of touched) recomputeContact(id);
    stats.contactsTouched = touched.size;

    if (nextSyncToken) {
      db.update(integrationAccounts)
        .set({ calendarSyncToken: nextSyncToken, updatedAt: Date.now() })
        .where(eq(integrationAccounts.id, account.id))
        .run();
    }
    db.update(syncRuns)
      .set({
        status: "success",
        statsJson: JSON.stringify(stats),
        cursorAfter: nextSyncToken ?? account.calendarSyncToken,
        finishedAt: Date.now(),
      })
      .where(eq(syncRuns.id, runId))
      .run();
    return stats;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.update(syncRuns)
      .set({ status: "failed", error: msg, finishedAt: Date.now() })
      .where(eq(syncRuns.id, runId))
      .run();
    if (err instanceof CalendarApiError && err.status === 401) {
      markAccountError(account.id, "Calendar authorization failed — reconnect.");
    }
    throw err;
  }
}
