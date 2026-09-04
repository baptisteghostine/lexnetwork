"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { contacts, interactions } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { recomputeContact } from "@/lib/cadence/recompute";

// The two things you can do with a "Worth reconnecting" pick (SPEC §3):
// say you reached out (a counting interaction — the clock resets and the
// pick retires), or wave it away (the cooldown starts, nothing else
// changes). Putting them on a cadence is the contact page's job.

export async function reachedOutAction(contactId: number): Promise<void> {
  await requireAuth();
  const now = Date.now();
  db.insert(interactions)
    .values({
      contactId,
      kind: "manual",
      occurredAt: now,
      title: "Reached out — reconnecting",
      source: "user",
      countsForTouch: true,
      createdAt: now,
    })
    .run();
  recomputeContact(contactId);
  revalidatePath("/today");
  revalidatePath(`/contacts/${contactId}`);
}

export async function dismissResurfaceAction(contactId: number): Promise<void> {
  await requireAuth();
  db.update(contacts)
    .set({ resurfaceDismissedAt: Date.now() })
    .where(eq(contacts.id, contactId))
    .run();
  revalidatePath("/today");
}
