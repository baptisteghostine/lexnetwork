import "server-only";

import { and, eq, gte, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts, contactSocials } from "@/db/schema";
import {
  clampDailyCap,
  nextBatch,
  publicIdentifierFromUrl,
  RECHECK_AFTER_MS,
  summarize,
  type EnrichCandidate,
  type EnrichResult,
  type EnrichSummary,
} from "@/lib/linkedin/enrich";
import { normalizeLinkedInUrl } from "@/lib/imports/linkedin";
import { getSetting } from "@/lib/settings";
import { executeLinkedInRows } from "@/server/linkedin-import";

// Server half of the profile-location enricher (SPEC §9d). The extension
// does the fetching — it is the only thing that can, since Cloudflare
// fingerprints the TLS handshake of anything else (SPEC §9c) — and this
// module decides who to ask about and what to do with the answers.
//
// Nothing here writes a contact field directly. Results go back through
// executeLinkedInRows, the same core the ZIP and the connection sync use,
// so a location inherits the identity ladder and the provenance rules for
// free: a location the owner typed by hand is never silently overwritten,
// it is reported as a conflict like any other field.

export function enrichEnabled(): boolean {
  return getSetting<boolean>("linkedin_enrich.enabled") ?? false;
}

export function dailyCap(): number {
  return clampDailyCap(getSetting<number>("linkedin_enrich.daily_cap"));
}

/** Contacts checked since `since` — the spent half of today's budget. */
export function checkedSince(since: number): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(contacts)
    .where(gte(contacts.locationCheckedAt, since))
    .get();
  return row?.n ?? 0;
}

/**
 * Everyone eligible for a location lookup: active, LinkedIn-sourced, and
 * either never checked or checked long enough ago to be worth re-asking.
 *
 * Contacts who already have a location are deliberately included when
 * their check is stale — someone who moved city is exactly the person the
 * map should stop showing in the wrong country. The provenance rules
 * decide whether the new value is allowed to land.
 */
export function enrichCandidates(now: number): EnrichCandidate[] {
  const rows = db
    .select({
      contactId: contacts.id,
      url: contactSocials.url,
      starred: contacts.starred,
      cadenceDays: contacts.cadenceDays,
      lastInteractionAt: contacts.lastInteractionAt,
      createdAt: contacts.createdAt,
      checkedAt: contacts.locationCheckedAt,
    })
    .from(contacts)
    .innerJoin(contactSocials, eq(contactSocials.contactId, contacts.id))
    .where(
      and(
        isNull(contacts.archivedAt),
        eq(contactSocials.platform, "linkedin"),
        sql`(${contacts.locationCheckedAt} IS NULL OR ${contacts.locationCheckedAt} < ${now - RECHECK_AFTER_MS})`
      )
    )
    .all();

  // One entry per contact: a contact can carry several LinkedIn URLs
  // (merge history, raw + normalized), and asking twice about the same
  // person would spend the budget on nothing.
  const byContact = new Map<number, EnrichCandidate>();
  for (const r of rows) {
    if (byContact.has(r.contactId)) continue;
    const normalized = normalizeLinkedInUrl(r.url);
    const publicIdentifier = normalized
      ? publicIdentifierFromUrl(normalized)
      : null;
    if (publicIdentifier === null) continue; // company/school page, not a person
    byContact.set(r.contactId, {
      contactId: r.contactId,
      publicIdentifier,
      starred: r.starred,
      hasCadence: r.cadenceDays !== null,
      lastInteractionAt: r.lastInteractionAt,
      createdAt: r.createdAt,
    });
  }
  return [...byContact.values()];
}

export type EnrichBatch = {
  profiles: { publicIdentifier: string }[];
  /** What is left of today's budget after this batch is handed out. */
  remainingToday: number;
  /** Everyone still waiting, so the popup can show honest progress. */
  queued: number;
};

/** Hand the extension the next slice of work. */
export function takeEnrichBatch(now: number, batchSize: number): EnrichBatch {
  const candidates = enrichCandidates(now);
  const cap = dailyCap();
  const spent = checkedSince(startOfDayWindow(now));
  const batch = nextBatch(candidates, {
    batchSize,
    dailyCap: cap,
    checkedToday: spent,
  });
  return {
    profiles: batch.map((c) => ({ publicIdentifier: c.publicIdentifier })),
    remainingToday: Math.max(0, cap - spent - batch.length),
    queued: candidates.length,
  };
}

/**
 * The daily budget is a rolling 24 hours, not a calendar day. A calendar
 * reset would let a run that started at 23:50 spend two days of budget in
 * ten minutes, which is exactly the burst this design avoids.
 */
export function startOfDayWindow(now: number): number {
  return now - 24 * 60 * 60 * 1000;
}

export type EnrichApplied = {
  summary: EnrichSummary;
  runId: number | null;
  stats: { new: number; updated: number; unchanged: number; conflicts: number };
};

/**
 * Record a round of results. Every attempted profile is stamped as checked
 * — including the ones with no location — so the queue advances instead of
 * offering the same placeless people again tomorrow.
 */
export function applyEnrichResults(
  results: EnrichResult[],
  contactIdsByIdentifier: Map<string, number>,
  now: number
): EnrichApplied {
  const summary = summarize(results);
  // Only enrich people we already know. These identifiers came from our own
  // queue, so a miss means the contact was merged or deleted while the
  // batch was in flight — and a row with a location but no name would
  // otherwise create a nameless contact out of that race.
  const located = results.filter(
    (r): r is EnrichResult & { location: string } =>
      r.location !== null && contactIdsByIdentifier.has(r.publicIdentifier)
  );

  let runId: number | null = null;
  let stats = { new: 0, updated: 0, unchanged: 0, conflicts: 0 };

  if (located.length > 0) {
    // Name fields are left empty on purpose: these rows exist to carry a
    // location onto a contact the profile URL already identifies, and an
    // empty field is never written (imports do not delete).
    const outcome = executeLinkedInRows({
      connections: located.map((r) => ({
        firstName: "",
        lastName: "",
        profileUrl: `linkedin.com/in/${r.publicIdentifier}`,
        profileUrlRaw: `https://www.linkedin.com/in/${r.publicIdentifier}`,
        email: null,
        company: null,
        position: null,
        connectedOn: null,
        location: r.location,
      })),
      messages: [],
      ownerName: null,
      runKind: "linkedin_profile_enrich",
      fileName: `profile-enrich-${new Date(now).toISOString().slice(0, 10)}`,
      fileSha256: null,
    });
    runId = outcome.runId;
    stats = {
      new: outcome.report.stats.new,
      updated: outcome.report.stats.updated,
      unchanged: outcome.report.stats.unchanged,
      conflicts: outcome.report.stats.conflicts,
    };
  }

  const stamped = results
    .map((r) => contactIdsByIdentifier.get(r.publicIdentifier))
    .filter((id): id is number => id !== undefined);
  for (const id of stamped) {
    db.update(contacts)
      .set({ locationCheckedAt: now })
      .where(eq(contacts.id, id))
      .run();
  }

  return { summary, runId, stats };
}

/** How full the map is: LinkedIn-sourced contacts, and how many have a
 * location. Drives the Settings progress line. */
export function linkedInLocationCounts(): { total: number; located: number } {
  const row = db
    .select({
      total: sql<number>`count(DISTINCT ${contacts.id})`,
      located: sql<number>`count(DISTINCT CASE WHEN ${contacts.location} IS NOT NULL AND ${contacts.location} != '' THEN ${contacts.id} END)`,
    })
    .from(contacts)
    .innerJoin(contactSocials, eq(contactSocials.contactId, contacts.id))
    .where(
      and(isNull(contacts.archivedAt), eq(contactSocials.platform, "linkedin"))
    )
    .get();
  return { total: row?.total ?? 0, located: row?.located ?? 0 };
}

/** contactId lookup for the identifiers in a batch, so results can be stamped. */
export function contactIdsFor(identifiers: string[]): Map<string, number> {
  const wanted = new Set(identifiers.map((i) => i.toLowerCase()));
  const map = new Map<string, number>();
  if (wanted.size === 0) return map;
  const rows = db
    .select({ contactId: contactSocials.contactId, url: contactSocials.url })
    .from(contactSocials)
    .where(eq(contactSocials.platform, "linkedin"))
    .all();
  for (const r of rows) {
    const normalized = normalizeLinkedInUrl(r.url);
    const id = normalized ? publicIdentifierFromUrl(normalized) : null;
    if (id !== null && wanted.has(id) && !map.has(id)) map.set(id, r.contactId);
  }
  return map;
}
