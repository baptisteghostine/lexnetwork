import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { noteMentions } from "@/db/schema";
import { recomputeContact } from "@/lib/cadence/recompute";
import { parseMentions } from "@/lib/notes/mentions";

// Shared by the note server actions and the autosave route: mention rows
// are always derived from the body, and a counting note counts for its
// own contact and everyone it @-mentions (SPEC §3, 2026-09-22), so every
// write that can change either has to recompute all of them.

/** Resync note_mentions rows from the body. Call inside a transaction. */
export function syncNoteMentions(noteId: number, bodyMd: string): void {
  db.delete(noteMentions).where(eq(noteMentions.noteId, noteId)).run();
  for (const m of parseMentions(bodyMd)) {
    db.insert(noteMentions)
      .values({
        noteId,
        contactId: m.kind === "contact" ? m.id : null,
        groupId: m.kind === "group" ? m.id : null,
      })
      .onConflictDoNothing()
      .run();
  }
}

export function mentionedContactIds(noteId: number): number[] {
  return db
    .select({ contactId: noteMentions.contactId })
    .from(noteMentions)
    .where(and(eq(noteMentions.noteId, noteId), isNotNull(noteMentions.contactId)))
    .all()
    .map((r) => r.contactId as number);
}

/** Recompute cadence columns and refresh the profile for each distinct contact. */
export function recomputeNoteContacts(ids: Iterable<number | null>): void {
  for (const id of new Set(ids)) {
    if (id === null) continue;
    recomputeContact(id);
    revalidatePath(`/contacts/${id}`);
  }
}
