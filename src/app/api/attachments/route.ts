import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { DATA_DIR, db } from "@/db/client";
import { attachments, notes } from "@/db/schema";
import { isAuthenticated } from "@/lib/auth";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file

// Upload an attachment for a note (multipart form: noteId + file).
export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const form = await req.formData().catch(() => null);
  const noteId = Number(form?.get("noteId"));
  const file = form?.get("file");
  if (!form || !Number.isInteger(noteId) || !(file instanceof File)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (file.size === 0 || file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }
  const note = db.select().from(notes).where(eq(notes.id, noteId)).get();
  if (!note) {
    return NextResponse.json({ error: "note not found" }, { status: 404 });
  }

  // Flatten any path components out of the client-supplied filename.
  const safeName =
    path.basename(file.name).replaceAll(/[^\w.\- ]/g, "_").slice(-120) ||
    "file";
  const relDir = path.join("attachments", String(noteId));
  fs.mkdirSync(path.join(DATA_DIR, relDir), { recursive: true });
  const relPath = path.join(relDir, `${Date.now()}-${safeName}`);
  fs.writeFileSync(
    path.join(DATA_DIR, relPath),
    Buffer.from(await file.arrayBuffer())
  );

  const row = db
    .insert(attachments)
    .values({
      noteId,
      filename: safeName,
      mime: file.type || "application/octet-stream",
      sizeBytes: file.size,
      path: relPath,
      createdAt: Date.now(),
    })
    .returning()
    .get();

  return NextResponse.json({
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    url: `/api/attachments/${row.id}`,
    isImage: row.mime.startsWith("image/"),
  });
}
