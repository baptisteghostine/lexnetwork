"use server";

import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { DATA_DIR, db } from "@/db/client";
import { attachments, interactions, notes } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { recomputeContact } from "@/lib/cadence/recompute";

export async function createNoteAction(
  contactId: number | null
): Promise<{ id: number }> {
  await requireAuth();
  const now = Date.now();
  const row = db
    .insert(notes)
    .values({ contactId, bodyMd: "", createdAt: now, updatedAt: now })
    .returning({ id: notes.id })
    .get();
  if (contactId) revalidatePath(`/contacts/${contactId}`);
  return { id: row.id };
}

export async function deleteNoteAction(noteId: number): Promise<void> {
  await requireAuth();
  const note = db.select().from(notes).where(eq(notes.id, noteId)).get();
  if (!note) return;
  const files = db
    .select()
    .from(attachments)
    .where(eq(attachments.noteId, noteId))
    .all();
  db.delete(notes).where(eq(notes.id, noteId)).run(); // cascades mentions + attachment rows
  for (const f of files) {
    // Attachment files are owned by the note (SPEC §2).
    fs.rmSync(path.join(DATA_DIR, f.path), { force: true });
  }
  if (note.contactId) {
    recomputeContact(note.contactId);
    revalidatePath(`/contacts/${note.contactId}`);
  }
}

export async function setNoteCountsForTouchAction(
  noteId: number,
  counts: boolean
): Promise<void> {
  await requireAuth();
  const note = db.select().from(notes).where(eq(notes.id, noteId)).get();
  if (!note) return;
  db.update(notes)
    .set({ countsForTouch: counts, updatedAt: Date.now() })
    .where(eq(notes.id, noteId))
    .run();
  if (note.contactId) {
    recomputeContact(note.contactId);
    revalidatePath(`/contacts/${note.contactId}`);
  }
}

const logInteractionInput = z.object({
  kind: z.enum(["manual", "meeting", "message", "email"]),
  title: z.string().trim().max(500),
  occurredAt: z.number().int().positive(),
});

export async function logInteractionAction(
  contactId: number,
  input: z.infer<typeof logInteractionInput>
): Promise<{ error?: string }> {
  await requireAuth();
  const parsed = logInteractionInput.safeParse(input);
  if (!parsed.success) return { error: "Invalid interaction." };
  db.insert(interactions)
    .values({
      contactId,
      kind: parsed.data.kind,
      occurredAt: parsed.data.occurredAt,
      title: parsed.data.title || null,
      // A manually logged email is by definition you reaching out.
      direction: parsed.data.kind === "email" ? "outbound" : null,
      source: "user",
      countsForTouch: true, // manually logged = you touched base (SPEC §3)
      createdAt: Date.now(),
    })
    .run();
  recomputeContact(contactId);
  revalidatePath(`/contacts/${contactId}`);
  return {};
}

export async function deleteInteractionAction(
  interactionId: number
): Promise<void> {
  await requireAuth();
  const row = db
    .select()
    .from(interactions)
    .where(eq(interactions.id, interactionId))
    .get();
  if (!row) return;
  db.delete(interactions).where(eq(interactions.id, interactionId)).run();
  recomputeContact(row.contactId);
  revalidatePath(`/contacts/${row.contactId}`);
}
