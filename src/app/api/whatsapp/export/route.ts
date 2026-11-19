import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

import { isAuthenticated } from "@/lib/auth";
import { importWhatsAppExport } from "@/server/whatsapp-core";

// Upload of a phone's "Export chat" file for one contact (SPEC §15). A
// route, not a server action: exports run to megabytes, past the action
// body limit. Session-gated like every other upload.

export const dynamic = "force-dynamic";

const MAX_BYTES = 60 * 1024 * 1024;

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const contactId = Number(form?.get("contactId"));
  const theirName = form?.get("theirName");
  if (!Number.isInteger(contactId) || contactId <= 0) {
    return NextResponse.json({ ok: false, error: "No contact." }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ ok: false, error: "Choose the export file first." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: "That file is over 60 MB. On the phone, export the chat again and choose Without media." },
      { status: 413 }
    );
  }
  const result = importWhatsAppExport(contactId, new Uint8Array(await file.arrayBuffer()), file.name, {
    theirName: typeof theirName === "string" ? theirName : undefined,
  });
  if (result.ok) {
    revalidatePath(`/contacts/${contactId}`);
    revalidatePath("/today");
    revalidatePath("/timeline");
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
