import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { noteMentions } from "@/db/schema";
import { parseMentions } from "@/lib/notes/mentions";

// Shared by the note server actions and the autosave route: mention rows
// are always derived from the body.

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
