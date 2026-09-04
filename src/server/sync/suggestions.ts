import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { contactEmails, contactSuggestions } from "@/db/schema";
import { normalizeEmail } from "@/lib/contacts/normalize";
import {
  isLikelyPerson,
  mergeRecent,
  rankSuggestions,
  type Sighting,
  type SightingInput,
} from "@/lib/suggestions/rank";

// "People you met" — the write side (SPEC §9f). The Gmail and Calendar
// syncs hand in every counterpart/attendee they couldn't match; this
// folds them into contact_suggestions. Nothing here creates a contact.

export function parseRecent(json: string | null): Sighting[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json);
    return Array.isArray(raw) ? (raw as Sighting[]) : [];
  } catch {
    return [];
  }
}

/** Fold a run's unmatched sightings in. Idempotent on the sighting key. */
export function recordSightings(
  sightings: SightingInput[],
  source: "gmail" | "calendar",
  now: number
): number {
  const byEmail = new Map<string, { email: string; name: string | null; items: Sighting[] }>();
  for (const s of sightings) {
    if (!isLikelyPerson(s.email)) continue;
    const key = normalizeEmail(s.email);
    const held = byEmail.get(key) ?? { email: s.email, name: null, items: [] };
    if (!held.name && s.name) held.name = s.name;
    held.items.push({ kind: s.kind, key: s.key, occurredAt: s.occurredAt, title: s.title, direction: s.direction });
    byEmail.set(key, held);
  }
  let touched = 0;
  for (const [emailNormalized, group] of byEmail) {
    const existing = db
      .select()
      .from(contactSuggestions)
      .where(eq(contactSuggestions.emailNormalized, emailNormalized))
      .get();
    const before = parseRecent(existing?.recentJson ?? null);
    const known = new Set(before.map((s) => s.key));
    const fresh = group.items.filter((s) => !known.has(s.key));
    if (fresh.length === 0 && existing) continue;
    const merged = mergeRecent(before, fresh);
    const outbound = fresh.filter((s) => s.kind === "email" && s.direction === "outbound").length;
    const inbound = fresh.filter((s) => s.kind === "email" && s.direction !== "outbound").length;
    const meetings = fresh.filter((s) => s.kind === "meeting").length;
    const newest = merged[0] ?? null;
    if (existing) {
      db.update(contactSuggestions)
        .set({
          name: existing.name ?? group.name,
          outboundCount: existing.outboundCount + outbound,
          inboundCount: existing.inboundCount + inbound,
          meetingCount: existing.meetingCount + meetings,
          lastSeenAt: Math.max(existing.lastSeenAt, newest?.occurredAt ?? 0),
          lastTitle: newest?.title ?? existing.lastTitle,
          recentJson: JSON.stringify(merged),
          updatedAt: now,
        })
        .where(eq(contactSuggestions.id, existing.id))
        .run();
    } else {
      db.insert(contactSuggestions)
        .values({
          emailNormalized,
          email: group.email,
          name: group.name,
          source,
          outboundCount: outbound,
          inboundCount: inbound,
          meetingCount: meetings,
          firstSeenAt: merged[merged.length - 1]?.occurredAt ?? now,
          lastSeenAt: newest?.occurredAt ?? now,
          lastTitle: newest?.title ?? null,
          recentJson: JSON.stringify(merged),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
    touched++;
  }
  return touched;
}

export type OpenSuggestion = {
  id: number;
  email: string;
  name: string | null;
  source: string;
  outboundCount: number;
  inboundCount: number;
  meetingCount: number;
  lastSeenAt: number;
  lastTitle: string | null;
};

/**
 * The queue, best first. A suggestion whose email has since become a
 * contact's (typed by hand, imported) is not open any more — hidden here
 * and stamped so it never comes back.
 */
export function openSuggestions(now: number, limit: number): { rows: OpenSuggestion[]; total: number } {
  const rows = db
    .select({
      id: contactSuggestions.id,
      email: contactSuggestions.email,
      emailNormalized: contactSuggestions.emailNormalized,
      name: contactSuggestions.name,
      source: contactSuggestions.source,
      outboundCount: contactSuggestions.outboundCount,
      inboundCount: contactSuggestions.inboundCount,
      meetingCount: contactSuggestions.meetingCount,
      lastSeenAt: contactSuggestions.lastSeenAt,
      lastTitle: contactSuggestions.lastTitle,
      matchedContactId: contactEmails.contactId,
    })
    .from(contactSuggestions)
    .leftJoin(contactEmails, eq(contactEmails.emailNormalized, contactSuggestions.emailNormalized))
    .where(and(isNull(contactSuggestions.dismissedAt), isNull(contactSuggestions.contactId)))
    .orderBy(desc(contactSuggestions.lastSeenAt))
    .all();
  const open: OpenSuggestion[] = [];
  for (const r of rows) {
    if (r.matchedContactId !== null) {
      db.update(contactSuggestions)
        .set({ contactId: r.matchedContactId, updatedAt: now })
        .where(eq(contactSuggestions.id, r.id))
        .run();
      continue;
    }
    open.push(r);
  }
  const ranked = rankSuggestions(open, now);
  return { rows: ranked.slice(0, limit), total: ranked.length };
}

export function openSuggestionCount(): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(contactSuggestions)
    .where(and(isNull(contactSuggestions.dismissedAt), isNull(contactSuggestions.contactId)))
    .get();
  return row?.n ?? 0;
}
