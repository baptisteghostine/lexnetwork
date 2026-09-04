"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import {
  contactEmails,
  contactFieldSources,
  contacts,
  contactSuggestions,
  interactions,
} from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { recomputeContact } from "@/lib/cadence/recompute";
import { deriveDisplayName, normalizeEmail } from "@/lib/contacts/normalize";
import { splitName } from "@/lib/suggestions/rank";
import { relinkAttendeeEmail } from "@/server/sync/calendar";
import { parseRecent } from "@/server/sync/suggestions";

// "People you met" — the owner's click (SPEC §9f). Approving creates the
// contact with the email and name the syncs saw, then backfills what
// they saw: every remembered email sighting becomes an interaction (same
// source/source_key the live sync would have written, so the next tick
// no-ops on them), and every calendar event carrying the address is
// re-matched so its meetings land on the timeline.

function revalidate(contactId?: number) {
  revalidatePath("/today");
  revalidatePath("/people-you-met");
  revalidatePath("/contacts");
  if (contactId) revalidatePath(`/contacts/${contactId}`);
}

export async function approveSuggestionAction(
  id: number
): Promise<{ contactId?: number; error?: string }> {
  await requireAuth();
  const row = db.select().from(contactSuggestions).where(eq(contactSuggestions.id, id)).get();
  if (!row) return { error: "Suggestion not found." };
  if (row.contactId !== null) return { contactId: row.contactId };
  const now = Date.now();

  // Someone may have typed this address onto a contact since.
  const already = db
    .select({ contactId: contactEmails.contactId })
    .from(contactEmails)
    .where(eq(contactEmails.emailNormalized, row.emailNormalized))
    .get();

  const contactId = db.transaction(() => {
    let cid = already?.contactId;
    if (cid === undefined) {
      const { firstName, lastName } = splitName(row.name, row.email);
      cid = db
        .insert(contacts)
        .values({
          firstName,
          lastName,
          displayName: deriveDisplayName({ firstName, lastName, primaryEmail: row.email }),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: contacts.id })
        .get().id;
      db.insert(contactEmails)
        .values({
          contactId: cid,
          email: row.email,
          emailNormalized: normalizeEmail(row.email),
          priority: 0,
          source: row.source,
          createdAt: now,
        })
        .run();
      for (const field of ["first_name", "last_name"] as const) {
        db.insert(contactFieldSources)
          .values({ contactId: cid, field, source: row.source, updatedAt: now })
          .onConflictDoNothing()
          .run();
      }
    }
    // Backfill the remembered email sightings; meetings come via relink.
    for (const s of parseRecent(row.recentJson)) {
      if (s.kind !== "email") continue;
      db.insert(interactions)
        .values({
          contactId: cid,
          kind: "email",
          direction: s.direction,
          occurredAt: s.occurredAt,
          title: s.title,
          meta: null,
          source: "gmail",
          sourceKey: s.key,
          countsForTouch: s.direction === "outbound",
          createdAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
    db.update(contactSuggestions)
      .set({ contactId: cid, updatedAt: now })
      .where(eq(contactSuggestions.id, id))
      .run();
    return cid;
  });

  relinkAttendeeEmail(row.emailNormalized, contactId, now);
  recomputeContact(contactId);
  revalidate(contactId);
  return { contactId };
}

export async function dismissSuggestionAction(id: number): Promise<void> {
  await requireAuth();
  db.update(contactSuggestions)
    .set({ dismissedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(contactSuggestions.id, id))
    .run();
  revalidate();
}
