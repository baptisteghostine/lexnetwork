// Minimal Phase 2 slice of the cadence engine: keep the derived
// contacts.last_interaction_at in sync. Phase 4 extends this module with
// next_touch_at, snooze handling, and the full recompute (see SPEC §3) —
// every interaction/note write path already funnels through here.
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts, interactions, notes } from "@/db/schema";

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

/** Call after any interaction/note write for the contact. */
export function recomputeContact(contactId: number): void {
  db.update(contacts)
    .set({ lastInteractionAt: computeLastInteractionAt(contactId) })
    .where(eq(contacts.id, contactId))
    .run();
}
