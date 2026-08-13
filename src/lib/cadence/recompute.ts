// DB glue for the cadence engine: keeps the derived columns
// contacts.last_interaction_at and contacts.next_touch_at in sync, and
// clears snoozes when a newer counting interaction lands (SPEC §3).
// Every interaction/note/cadence write path calls recomputeContact().
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts, interactions, notes } from "@/db/schema";
import { computeNextTouchAt } from "./engine";

/** Max occurred_at across counting interactions + counting notes, or null. */
export function computeLastInteractionAt(contactId: number): number | null {
  const latestInteraction = db
    .select({ at: interactions.occurredAt })
    .from(interactions)
    .where(
      and(
        eq(interactions.contactId, contactId),
        eq(interactions.countsForTouch, true)
      )
    )
    .orderBy(desc(interactions.occurredAt))
    .limit(1)
    .get();
  const latestNote = db
    .select({ at: notes.createdAt })
    .from(notes)
    .where(
      and(eq(notes.contactId, contactId), eq(notes.countsForTouch, true))
    )
    .orderBy(desc(notes.createdAt))
    .limit(1)
    .get();
  const candidates = [latestInteraction?.at, latestNote?.at].filter(
    (v): v is number => typeof v === "number"
  );
  return candidates.length ? Math.max(...candidates) : null;
}

/** Call after any interaction/note/cadence/snooze write for the contact. */
export function recomputeContact(contactId: number): void {
  const c = db
    .select({
      cadenceDays: contacts.cadenceDays,
      cadenceAssignedAt: contacts.cadenceAssignedAt,
      lastInteractionAt: contacts.lastInteractionAt,
      snoozedUntil: contacts.snoozedUntil,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .get();
  if (!c) return;

  const newLast = computeLastInteractionAt(contactId);
  // A newer counting interaction clears any snooze — the clock restarts
  // from real contact, not from the postponement (SPEC §3).
  const snoozedUntil =
    newLast !== null && (c.lastInteractionAt === null || newLast > c.lastInteractionAt)
      ? null
      : c.snoozedUntil;

  const nextTouchAt = computeNextTouchAt({
    cadenceDays: c.cadenceDays,
    cadenceAssignedAt: c.cadenceAssignedAt,
    lastInteractionAt: newLast,
    snoozedUntil,
  });

  db.update(contacts)
    .set({ lastInteractionAt: newLast, snoozedUntil, nextTouchAt })
    .where(eq(contacts.id, contactId))
    .run();
}
