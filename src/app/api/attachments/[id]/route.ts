import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { DATA_DIR, db } from "@/db/client";
import { attachments } from "@/db/schema";
import { isAuthenticated } from "@/lib/auth";

// Serve an attachment from disk (auth-gated — data/ is never public).
export async function GET(
  _req: NextRequest,
  ctx: RouteContext<"/api/attachments/[id]">
) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const row = db
    .select()
    .from(attachments)
    .where(eq(attachments.id, Number(id)))
    .get();
  if (!row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const abs = path.join(DATA_DIR, row.path);
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
      "Content-Type": row.mime,
      "Content-Disposition": `inline; filename="${row.filename}"`,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
