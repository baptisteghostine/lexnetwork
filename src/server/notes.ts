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
import {
  addNote,
  INTERACTION_KINDS,
  INTERACTION_TITLE_MAX,
  NOTE_BODY_MAX,
  recordInteraction,
} from "@/server/interaction-core";
import { mentionedContactIds, recomputeNoteContacts } from "@/server/note-sync";

export async function createNoteAction(
  contactId: number | null
): Promise<{ id: number }> {
  await requireAuth();
  // An empty note the editor then autosaves into (SPEC §2).
  const res = addNote({ contactId, bodyMd: "" });
  if (!res.ok) throw new Error(res.error);
  if (contactId) revalidatePath(`/contacts/${contactId}`);
  return { id: res.noteId };
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
  const mentioned = mentionedContactIds(noteId);
  db.delete(notes).where(eq(notes.id, noteId)).run(); // cascades mentions + attachment rows
  for (const f of files) {
    // Attachment files are owned by the note (SPEC §2).
    fs.rmSync(path.join(DATA_DIR, f.path), { force: true });
  }
  // A counting note counted for its contact and everyone it mentioned.
  recomputeNoteContacts([note.contactId, ...mentioned]);
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
  // Counts for the note's contact and for every contact it @-mentions
  // (SPEC §3) — a note written from Today or the Notes page has no
  // contact of its own, and the mention is the only link.
  recomputeNoteContacts([note.contactId, ...mentionedContactIds(noteId)]);
}

const logInteractionInput = z.object({
  kind: z.enum(INTERACTION_KINDS),
  title: z.string().trim().max(INTERACTION_TITLE_MAX),
  occurredAt: z.number().int().positive(),
  /** Optional markdown notes → a note row dated to the interaction (SPEC §2). */
  noteMd: z.string().max(NOTE_BODY_MAX).optional(),
});

export async function logInteractionAction(
  contactId: number,
  input: z.infer<typeof logInteractionInput>
): Promise<{ error?: string }> {
  await requireAuth();
  const parsed = logInteractionInput.safeParse(input);
  if (!parsed.success) return { error: "Invalid interaction." };
  const res = recordInteraction({
    contactId,
    kind: parsed.data.kind,
    occurredAt: parsed.data.occurredAt,
    title: parsed.data.title,
    // A manually logged email is by definition you reaching out, so it
    // counts like every other manual log (SPEC §3).
    direction: parsed.data.kind === "email" ? "outbound" : null,
    source: "user",
    noteMd: parsed.data.noteMd,
  });
  if (!res.ok) return { error: res.error };
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
