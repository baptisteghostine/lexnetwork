import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { recomputeContact } from "@/lib/cadence/recompute";

// Setting how often to keep in touch with someone (SPEC §3), without a
// session: the Keep-in-touch actions and the agent connector's
// set_cadence share it. Plain module, not "use server" — see CLAUDE.md.

export const CADENCE_DAYS_MIN = 1;
export const CADENCE_DAYS_MAX = 3650;

export type CadenceState = {
  cadenceDays: number | null;
  cadenceAssignedAt: number | null;
  cadenceReviewedAt: number | null;
  snoozedUntil: number | null;
};

export type SetCadenceResult =
  | { ok: true; before: CadenceState; after: CadenceState; nextTouchAt: number | null }
  | { ok: false; error: string };

function read(contactId: number): CadenceState | null {
  return (
    db
      .select({
        cadenceDays: contacts.cadenceDays,
        cadenceAssignedAt: contacts.cadenceAssignedAt,
        cadenceReviewedAt: contacts.cadenceReviewedAt,
        snoozedUntil: contacts.snoozedUntil,
      })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .get() ?? null
  );
}

/**
 * Put a contact on a cadence of `days`, or take them off one (`null`).
 * Returns what it replaced, so a caller can offer undo.
 */
export function setCadence(contactId: number, days: number | null, now = Date.now()): SetCadenceResult {
  if (days !== null && (!Number.isInteger(days) || days < CADENCE_DAYS_MIN || days > CADENCE_DAYS_MAX)) {
    return { ok: false, error: `Cadence must be ${CADENCE_DAYS_MIN}–${CADENCE_DAYS_MAX} days.` };
  }
  const before = read(contactId);
  if (!before) return { ok: false, error: "Contact not found." };
  db.update(contacts)
    .set({
      cadenceDays: days,
      // Re-assigning restarts the no-interaction baseline; clearing wipes it.
      cadenceAssignedAt: days === null ? null : now,
      // Any deliberate pick here — including "no cadence" — is a triage
      // decision, so it leaves the board's Uncategorized column. Only the
      // board itself can put someone back to never-triaged (SPEC §3a).
      cadenceReviewedAt: now,
      snoozedUntil: null,
      updatedAt: now,
    })
    .where(eq(contacts.id, contactId))
    .run();
  recomputeContact(contactId);
  const after = read(contactId);
  if (!after) return { ok: false, error: "Contact not found." };
  const nextTouchAt =
    db.select({ at: contacts.nextTouchAt }).from(contacts).where(eq(contacts.id, contactId)).get()?.at ?? null;
  return { ok: true, before, after, nextTouchAt };
}

/** Put a cadence back exactly as it was — the other half of undo. */
export function restoreCadence(contactId: number, state: CadenceState, now = Date.now()): void {
  db.update(contacts)
    .set({
      cadenceDays: state.cadenceDays,
      cadenceAssignedAt: state.cadenceAssignedAt,
      cadenceReviewedAt: state.cadenceReviewedAt,
      // A snooze that has since lapsed is not brought back.
      snoozedUntil: state.snoozedUntil !== null && state.snoozedUntil > now ? state.snoozedUntil : null,
      updatedAt: now,
    })
    .where(eq(contacts.id, contactId))
    .run();
  recomputeContact(contactId);
}
