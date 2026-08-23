import "server-only";

import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import {
  GEOCODE_BATCH_MAX,
  GEOCODE_DELAY_MS,
  GEOCODE_RETRY_AFTER_MS,
  GEOCODE_USER_AGENT,
  nominatimUrl,
  parseNominatimResponse,
} from "@/lib/geo/geocode";
import { outboundFetch } from "@/lib/net/fetch";
import { getSetting } from "@/lib/settings";

// The geocode job (SPEC §7a city placement, decision #4). Runs off the
// same scheduler as every other sync; the 'geocode' job kind has been
// reserved in SCHEMA.md since day one, and this fills it.
//
// Shape mirrors the LinkedIn enricher deliberately: distinct work items,
// polite serial pacing, stamp every attempt including misses, and a
// recurring job that no-ops cheaply when there is nothing left. The unit
// of work here is the *location string*, not the contact — one lookup
// per distinct string, fanned out to everyone who shares it.

export function geocodeEnabled(): boolean {
  return getSetting<boolean>("geocode.enabled") ?? false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Distinct location strings still owed a lookup, most-shared first so
 * one request places the most people. */
export function pendingLocations(
  now: number,
  limit: number
): { location: string; contacts: number }[] {
  return db
    .select({
      location: contacts.location,
      n: sql<number>`count(*)`,
    })
    .from(contacts)
    .where(
      and(
        isNull(contacts.archivedAt),
        isNotNull(contacts.location),
        ne(contacts.location, ""),
        isNull(contacts.locationLat),
        or(
          isNull(contacts.geocodeAttemptedAt),
          sql`${contacts.geocodeAttemptedAt} < ${now - GEOCODE_RETRY_AFTER_MS}`
        )
      )
    )
    .groupBy(contacts.location)
    .orderBy(sql`count(*) DESC`)
    .limit(limit)
    .all()
    .map((r) => ({ location: r.location as string, contacts: r.n }));
}

export type GeocodeRunResult = {
  looked: number;
  placed: number;
  contactsPlaced: number;
  remaining: number;
};

/**
 * One batch of lookups. Throws on transport errors and rate limits — the
 * scheduler's backoff is the retry policy, and a 429 must stop the run,
 * never be routed around (same rule as every LinkedIn path).
 */
export async function runGeocode(now: number): Promise<GeocodeRunResult> {
  if (!geocodeEnabled()) {
    return { looked: 0, placed: 0, contactsPlaced: 0, remaining: 0 };
  }
  const batch = pendingLocations(now, GEOCODE_BATCH_MAX);
  let looked = 0;
  let placed = 0;
  let contactsPlaced = 0;

  for (const item of batch) {
    const res = await outboundFetch(nominatimUrl(item.location), {
      headers: {
        "user-agent": GEOCODE_USER_AGENT,
        accept: "application/json",
      },
    });
    if (res.status === 429 || res.status === 403) {
      throw new Error(
        `Nominatim rate-limited the request (HTTP ${res.status}) after ${looked} lookups — the job will back off and continue.`
      );
    }
    if (!res.ok) {
      throw new Error(`Nominatim returned HTTP ${res.status}.`);
    }
    const point = parseNominatimResponse(await res.json());
    looked += 1;

    // Fan the answer out to everyone sharing the string; stamp the
    // attempt either way so a miss doesn't stay at the head of the
    // queue forever.
    const stampedAt = Date.now();
    const updated = db
      .update(contacts)
      .set(
        point !== null
          ? {
              locationLat: point.lat,
              locationLng: point.lng,
              geocodeAttemptedAt: stampedAt,
            }
          : { geocodeAttemptedAt: stampedAt }
      )
      .where(
        and(eq(contacts.location, item.location), isNull(contacts.locationLat))
      )
      .run();
    if (point !== null) {
      placed += 1;
      contactsPlaced += updated.changes;
    }

    await sleep(GEOCODE_DELAY_MS);
  }

  const remaining = pendingLocations(now, 1).length;
  return { looked, placed, contactsPlaced, remaining };
}

/** Settings-card progress: distinct strings placed / total with a location. */
export function geocodeProgress(): {
  contactsWithLocation: number;
  contactsPlaced: number;
} {
  const row = db
    .select({
      total: sql<number>`count(*)`,
      placed: sql<number>`count(${contacts.locationLat})`,
    })
    .from(contacts)
    .where(
      and(
        isNull(contacts.archivedAt),
        isNotNull(contacts.location),
        ne(contacts.location, "")
      )
    )
    .get();
  return {
    contactsWithLocation: row?.total ?? 0,
    contactsPlaced: row?.placed ?? 0,
  };
}
