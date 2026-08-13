import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { DATA_DIR, db } from "@/db/client";
import { contacts } from "@/db/schema";
import { isAuthenticated } from "@/lib/auth";

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// Serve a contact photo from disk (auth-gated — data/ is never public).
export async function GET(
  _req: NextRequest,
  ctx: RouteContext<"/api/photos/[contactId]">
) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { contactId } = await ctx.params;
  const row = db
    .select({ photoPath: contacts.photoPath })
    .from(contacts)
    .where(eq(contacts.id, Number(contactId)))
    .get();
  if (!row?.photoPath) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const abs = path.join(DATA_DIR, row.photoPath);
  if (!abs.startsWith(path.join(DATA_DIR, "attachments"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return NextResponse.json({ error: "file missing" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": MIME[path.extname(abs).toLowerCase()] ?? "image/jpeg",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
