"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { contactFieldSources, contacts, interactions } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { recomputeContact } from "@/lib/cadence/recompute";
import { deriveDisplayName } from "@/lib/contacts/normalize";

// "Who did you meet?" quick log (SPEC §2 amendment): one modal, anywhere
// in the app — find or create the person, one line of what happened,
// when — lands as a counting manual interaction so the keep-in-touch
// clock advances. The Dex capture pattern, minus the extra screens.

const quickLogInput = z
  .object({
    contactId: z.number().int().positive().optional(),
    newContactName: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(500),
    occurredAt: z
      .number()
      .int()
      .min(Date.UTC(1990, 0, 1))
      // A meeting you're logging happened — allow today (any timezone's
      // today), never the future. Checked at call time, not module load.
      .refine((t) => t <= Date.now() + 26 * 3600 * 1000, {
        message: "The date can't be in the future.",
      }),
  })
  .refine((v) => (v.contactId === undefined) !== (v.newContactName === undefined), {
    message: "Pick a contact or name a new one, not both.",
  });

export type QuickLogResult = { error?: string; contactId?: number };

export async function quickLogAction(
  input: z.infer<typeof quickLogInput>
): Promise<QuickLogResult> {
  await requireAuth();
  const parsed = quickLogInput.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const now = Date.now();

  const contactId = db.transaction(() => {
    let id = parsed.data.contactId;
    if (id === undefined) {
      const name = parsed.data.newContactName!;
      const spaceAt = name.indexOf(" ");
      const firstName = spaceAt === -1 ? name : name.slice(0, spaceAt);
      const lastName = spaceAt === -1 ? null : name.slice(spaceAt + 1).trim() || null;
      id = Number(
        db
          .insert(contacts)
          .values({
            firstName,
            lastName,
            displayName: deriveDisplayName({ firstName, lastName }),
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: contacts.id })
          .get().id
      );
      for (const field of ["first_name", "last_name"] as const) {
        db.insert(contactFieldSources)
          .values({ contactId: id, field, source: "user", updatedAt: now })
          .run();
      }
    } else {
      const exists = db
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.id, id))
        .get();
      if (!exists) throw new Error("Contact not found.");
    }

    db.insert(interactions)
      .values({
        contactId: id,
        kind: "manual",
        occurredAt: parsed.data.occurredAt,
        title: parsed.data.title,
        source: "user",
        countsForTouch: true, // you met them — the clock resets (SPEC §3)
        createdAt: now,
      })
      .run();
    return id;
  });

  recomputeContact(contactId);
  revalidatePath("/today");
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${contactId}`);
  return { contactId };
}
