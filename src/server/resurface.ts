import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { contactChanges, contacts, interactions } from "@/db/schema";
import {
  clampResurfacePerDay,
  pickResurface,
  type ResurfaceCandidate,
} from "@/lib/resurface/score";
import { getSetting, setSetting } from "@/lib/settings";
import { fromFakeUtc, localDateKey, localParts } from "@/lib/time";

// "Worth reconnecting" — the DB half (SPEC §3). Picks are made once per
// local day, lazily, by whichever reader comes first (the Today page or
// the digest), and stamped on the contact so both show the same people
// and nobody comes round again inside the cooldown. No job kind: the
// pick is a read that writes, like ensureExtensionToken.
//
// NOTE: no "server-only" here — the digest job reads this outside a
// request context.

const LAST_PICK_KEY = "resurface.last_pick_date";

export function resurfaceEnabled(): boolean {
  return getSetting<boolean>("resurface.enabled") ?? true;
}

export function resurfacePerDay(): number {
  return clampResurfacePerDay(getSetting<number>("resurface.per_day"));
}

function candidates(): ResurfaceCandidate[] {
  const counts = new Map<number, number>();
  for (const r of db
    .select({ contactId: interactions.contactId, n: sql<number>`count(*)` })
    .from(interactions)
    .where(eq(interactions.countsForTouch, true))
    .groupBy(interactions.contactId)
    .all()) {
    counts.set(r.contactId, r.n);
  }
  const openChange = new Set(
    db
      .selectDistinct({ contactId: contactChanges.contactId })
      .from(contactChanges)
      .where(and(isNull(contactChanges.dismissedAt), isNull(contactChanges.actedAt)))
      .all()
      .map((r) => r.contactId)
  );
  return db
    .select({
      id: contacts.id,
      starred: contacts.starred,
      archivedAt: contacts.archivedAt,
      cadenceDays: contacts.cadenceDays,
      cadenceReviewedAt: contacts.cadenceReviewedAt,
      lastInteractionAt: contacts.lastInteractionAt,
      resurfacedAt: contacts.resurfacedAt,
      resurfaceDismissedAt: contacts.resurfaceDismissedAt,
    })
    .from(contacts)
    .where(and(isNull(contacts.archivedAt), isNull(contacts.cadenceDays)))
    .all()
    .map((c) => ({
      ...c,
      interactionCount: counts.get(c.id) ?? 0,
      hasOpenChange: openChange.has(c.id),
    }));
}

/** Make today's picks if nobody has yet. Returns how many were stamped. */
export function ensureResurfacePicks(now: number, timezone: string): number {
  if (!resurfaceEnabled()) return 0;
  const today = localDateKey(timezone, now);
  if (getSetting<string>(LAST_PICK_KEY) === today) return 0;
  const picks = pickResurface(candidates(), now, resurfacePerDay());
  if (picks.length > 0) {
    db.update(contacts)
      .set({ resurfacedAt: now })
      .where(inArray(contacts.id, picks.map((p) => p.id)))
      .run();
  }
  setSetting(LAST_PICK_KEY, today);
  return picks.length;
}

export type ResurfacePick = {
  contactId: number;
  displayName: string;
  title: string | null;
  company: string | null;
  starred: boolean;
  hasPhoto: boolean;
  lastInteractionAt: number | null;
  interactionCount: number;
  hasOpenChange: boolean;
};

/** Today's picks: stamped today, not dismissed, not yet acted on. */
export function todaysResurfacePicks(now: number, timezone: string): ResurfacePick[] {
  if (!resurfaceEnabled()) return [];
  ensureResurfacePicks(now, timezone);
  const local = localParts(timezone, now);
  const dayStart = fromFakeUtc(timezone, Date.UTC(local.year, local.month - 1, local.day));
  const rows = db
    .select()
    .from(contacts)
    .where(
      and(
        isNull(contacts.archivedAt),
        gte(contacts.resurfacedAt, dayStart),
        isNull(contacts.resurfaceDismissedAt)
      )
    )
    .all()
    // Acting on the pick (a counting interaction after the showing)
    // retires it without a separate stamp.
    .filter((c) => (c.lastInteractionAt ?? 0) < (c.resurfacedAt ?? 0));
  if (rows.length === 0) return [];
  const counts = new Map<number, number>();
  for (const r of db
    .select({ contactId: interactions.contactId, n: sql<number>`count(*)` })
    .from(interactions)
    .where(
      and(
        eq(interactions.countsForTouch, true),
        inArray(interactions.contactId, rows.map((c) => c.id))
      )
    )
    .groupBy(interactions.contactId)
    .all()) {
    counts.set(r.contactId, r.n);
  }
  const openChange = new Set(
    db
      .selectDistinct({ contactId: contactChanges.contactId })
      .from(contactChanges)
      .where(
        and(
          inArray(contactChanges.contactId, rows.map((c) => c.id)),
          isNull(contactChanges.dismissedAt),
          isNull(contactChanges.actedAt)
        )
      )
      .all()
      .map((r) => r.contactId)
  );
  return rows
    .sort((a, b) => (b.resurfacedAt ?? 0) - (a.resurfacedAt ?? 0) || a.id - b.id)
    .map((c) => ({
      contactId: c.id,
      displayName: c.displayName,
      title: c.title,
      company: c.company,
      starred: c.starred,
      hasPhoto: c.photoPath !== null,
      lastInteractionAt: c.lastInteractionAt,
      interactionCount: counts.get(c.id) ?? 0,
      hasOpenChange: openChange.has(c.id),
    }));
}
