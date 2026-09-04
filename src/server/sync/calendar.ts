import "server-only";

import { and, eq, gte, inArray, lte } from "drizzle-orm";

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
  CALENDAR_FUTURE_WINDOW_MS,
  CALENDAR_PAST_WINDOW_MS,
  parseEventsPage,
  storedEventCountsAsMeeting,
  type CalendarEventParsed,
} from "@/lib/sync/gcal";
import type { SightingInput } from "@/lib/suggestions/rank";
import {
  accessTokenFor,
  getAccount,
  markAccountError,
} from "@/server/sync/accounts";
import { recordSightings } from "@/server/sync/suggestions";

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

/**
 * Delete the meeting interactions recorded for an event that no longer
 * happened (cancelled, or removed server-side), returning the contacts
 * whose cadence needs recomputing.
 */
function deleteMeetingInteractions(eventKeys: string[], touched: Set<number>): void {
  for (let i = 0; i < eventKeys.length; i += 200) {
    const chunk = eventKeys.slice(i, i + 200);
    const rows = db
      .select({ contactId: interactions.contactId })
      .from(interactions)
      .where(
        and(eq(interactions.source, "calendar"), inArray(interactions.sourceKey, chunk))
      )
      .all();
    if (rows.length === 0) continue;
    for (const r of rows) touched.add(r.contactId);
    db.delete(interactions)
      .where(
        and(eq(interactions.source, "calendar"), inArray(interactions.sourceKey, chunk))
      )
      .run();
  }
}

function upsertEvent(
  accountId: number,
  e: CalendarEventParsed,
  matched: { email: string; name: string | null; contactId: number | null }[],
  now: number,
  touched: Set<number>,
  sightings: SightingInput[]
): void {
  if (e.status === "cancelled") {
    db.delete(calendarEvents).where(eq(calendarEvents.eventKey, e.eventKey)).run();
    // A meeting already promoted to an interaction never happened after all.
    deleteMeetingInteractions([e.eventKey], touched);
    return;
  }
  // Attendees Rolo doesn't know feed the "People you met" queue (SPEC
  // §9f) — a meeting the owner accepted, not one they declined.
  if (e.myResponse !== "declined") {
    for (const a of matched) {
      if (a.contactId !== null) continue;
      sightings.push({
        email: a.email,
        name: a.name,
        kind: "meeting",
        key: e.eventKey,
        occurredAt: e.startsAt,
        title: e.summary,
        direction: null,
      });
    }
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

type StoredAttendee = { email: string; name: string | null; contactId: number | null };

function parseStoredAttendees(json: string | null): StoredAttendee[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json);
    return Array.isArray(raw) ? (raw as StoredAttendee[]) : [];
  } catch {
    return [];
  }
}

/**
 * Reconcile meeting interactions against the whole event cache, not just
 * this run's deltas. Incremental sync typically delivers an event once, at
 * creation, while it is still in the future — nothing redelivers it after
 * it occurs, so promotion to an interaction has to happen here, on every
 * tick. The same pass demotes events that stopped counting (declined after
 * the fact, or rescheduled back into the future).
 */
function reconcileMeetingInteractions(
  now: number,
  stats: CalendarSyncStats,
  touched: Set<number>
): void {
  const rows = db
    .select({
      eventKey: calendarEvents.eventKey,
      summary: calendarEvents.summary,
      startsAt: calendarEvents.startsAt,
      endsAt: calendarEvents.endsAt,
      status: calendarEvents.status,
      myResponse: calendarEvents.myResponse,
      attendees: calendarEvents.attendees,
    })
    .from(calendarEvents)
    .all();

  for (const row of rows) {
    const attendees = parseStoredAttendees(row.attendees);
    const matchedIds = [
      ...new Set(
        attendees
          .map((a) => a.contactId)
          .filter((id): id is number => typeof id === "number")
      ),
    ];
    const counts =
      attendees.length > 0 && storedEventCountsAsMeeting(row, now);

    if (!counts) {
      // Declined, tentative, or moved back into the future — a previously
      // recorded interaction claims a meeting that didn't (yet) happen.
      deleteMeetingInteractions([row.eventKey], touched);
      continue;
    }

    const existing = db
      .select({
        id: interactions.id,
        contactId: interactions.contactId,
        occurredAt: interactions.occurredAt,
        title: interactions.title,
      })
      .from(interactions)
      .where(
        and(
          eq(interactions.source, "calendar"),
          eq(interactions.sourceKey, row.eventKey)
        )
      )
      .all();
    const byContact = new Map(existing.map((r) => [r.contactId, r]));

    for (const contactId of matchedIds) {
      const have = byContact.get(contactId);
      if (!have) {
        db.insert(interactions)
          .values({
            contactId,
            kind: "meeting",
            direction: null,
            occurredAt: row.startsAt,
            title: row.summary,
            meta: JSON.stringify({ eventId: row.eventKey }),
            source: "calendar",
            sourceKey: row.eventKey,
            countsForTouch: true,
            createdAt: Date.now(),
          })
          .run();
        stats.meetingsAdded++;
        touched.add(contactId);
      } else if (have.occurredAt !== row.startsAt || have.title !== row.summary) {
        // Rescheduled (still in the past) or retitled: refresh in place.
        db.update(interactions)
          .set({ occurredAt: row.startsAt, title: row.summary })
          .where(eq(interactions.id, have.id))
          .run();
        touched.add(contactId);
      }
    }
    // An attendee removed from the event no longer met anyone.
    for (const r of existing) {
      if (!matchedIds.includes(r.contactId)) {
        db.delete(interactions).where(eq(interactions.id, r.id)).run();
        touched.add(r.contactId);
      }
    }
  }
}

/**
 * After a full-window (re-)list: stored events inside the window that the
 * listing didn't return were deleted (or moved out of the window) while no
 * valid syncToken was watching — drop them and their interactions.
 */
function pruneUnseenWindowEvents(
  now: number,
  seenKeys: Set<string>,
  touched: Set<number>
): void {
  const windowStart = now - CALENDAR_PAST_WINDOW_MS;
  const windowEnd = now + CALENDAR_FUTURE_WINDOW_MS;
  const stored = db
    .select({ eventKey: calendarEvents.eventKey })
    .from(calendarEvents)
    .where(
      and(gte(calendarEvents.startsAt, windowStart), lte(calendarEvents.startsAt, windowEnd))
    )
    .all();
  const stale = stored.map((r) => r.eventKey).filter((k) => !seenKeys.has(k));
  if (stale.length === 0) return;
  for (let i = 0; i < stale.length; i += 200) {
    const chunk = stale.slice(i, i + 200);
    db.delete(calendarEvents).where(inArray(calendarEvents.eventKey, chunk)).run();
  }
  deleteMeetingInteractions(stale, touched);
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
  const sightings: SightingInput[] = [];

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

    // Event keys seen during a full-window run — anything stored inside the
    // window but absent from the listing was deleted server-side while the
    // syncToken was invalid, and must be pruned along with its interactions.
    const seenKeys = new Set<string>();

    const consumePages = async (incremental: boolean): Promise<void> => {
      do {
        const url = incremental
          ? buildEventsIncrementalUrl({ syncToken: syncToken!, pageToken })
          : buildEventsWindowUrl({ now, pageToken });
        const page = parseEventsPage(await gcalJson(url, token));
        for (const e of page.events) {
          stats.eventsSeen++;
          if (!incremental) seenKeys.add(e.eventKey);
          upsertEvent(account.id, e, matchAttendees(e), now, touched, sightings);
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

    if (stats.fullWindow) pruneUnseenWindowEvents(now, seenKeys, touched);
    reconcileMeetingInteractions(now, stats, touched);

    for (const id of touched) recomputeContact(id);
    stats.contactsTouched = touched.size;
    recordSightings(sightings, "calendar", Date.now());

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

/**
 * An address just became a contact's (SPEC §9f approval, or a manual
 * edit): re-match it across the stored events and promote the meetings
 * it was on. Same reconcile pass the sync runs, so the rows it writes are
 * indistinguishable from ones the sync would have written.
 */
export function relinkAttendeeEmail(
  emailNormalized: string,
  contactId: number,
  now: number
): number {
  const rows = db
    .select({ id: calendarEvents.id, attendees: calendarEvents.attendees })
    .from(calendarEvents)
    .all();
  let changed = 0;
  for (const r of rows) {
    const list = parseStoredAttendees(r.attendees);
    let hit = false;
    for (const a of list) {
      if (a.contactId === null && normalizeEmail(a.email) === emailNormalized) {
        a.contactId = contactId;
        hit = true;
      }
    }
    if (!hit) continue;
    db.update(calendarEvents)
      .set({ attendees: JSON.stringify(list), updatedAt: now })
      .where(eq(calendarEvents.id, r.id))
      .run();
    changed++;
  }
  if (changed > 0) {
    const touched = new Set<number>();
    const stats: CalendarSyncStats = { eventsSeen: 0, meetingsAdded: 0, contactsTouched: 0, fullWindow: false };
    reconcileMeetingInteractions(now, stats, touched);
    for (const id of touched) recomputeContact(id);
  }
  return changed;
}
