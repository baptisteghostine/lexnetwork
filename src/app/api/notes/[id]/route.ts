import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { noteMentions, notes } from "@/db/schema";
import { isAuthenticated } from "@/lib/auth";
import { parseMentions } from "@/lib/notes/mentions";

const saveInput = z.object({ bodyMd: z.string().max(200_000) });

// Autosave endpoint — called from the editor's debounce and (with
// fetch keepalive) from beforeunload, which server actions can't serve.
export async function PUT(
  req: NextRequest,
  ctx: RouteContext<"/api/notes/[id]">
) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const noteId = Number(id);
  const note = db.select().from(notes).where(eq(notes.id, noteId)).get();
  if (!note) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsed = saveInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }

  const bodyMd = parsed.data.bodyMd;
  db.transaction(() => {
    db.update(notes)
      .set({ bodyMd, updatedAt: Date.now() })
      .where(eq(notes.id, noteId))
      .run();
    // note_mentions rows are always derived from the body — resync fully.
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
  });
  return NextResponse.json({ savedAt: Date.now() });
}
