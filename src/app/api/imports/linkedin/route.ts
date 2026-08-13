import crypto from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { isAuthenticated } from "@/lib/auth";
import { executeLinkedInImport } from "@/server/linkedin-import";

const MAX_BYTES = 200 * 1024 * 1024;

// One-shot LinkedIn ZIP import: the ritual is drop → report. Idempotency
// (SHA short-circuit + per-row rules) makes re-uploads safe, so there is
// no dry-run step here.
export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file" }, { status: 400 });
  }
  if (file.size === 0 || file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const force = form?.get("force") === "1";

  const result = executeLinkedInImport({
    zip: new Uint8Array(buf),
    fileName: file.name,
    fileSha256: sha,
    force,
  });

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 422 });
  }
  if ("duplicateOf" in result) {
    return NextResponse.json({ duplicateOf: result.duplicateOf });
  }
  return NextResponse.json({ runId: result.runId, stats: result.report.stats });
}
