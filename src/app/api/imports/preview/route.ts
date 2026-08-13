import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { DATA_DIR } from "@/db/client";
import { isAuthenticated } from "@/lib/auth";
import { parseCsv } from "@/lib/imports/csv";
import {
  guessMapping,
  headerSignature,
  type Mapping,
} from "@/lib/imports/mapping";
import { parseVcards } from "@/lib/imports/vcard";
import { getSetting } from "@/lib/settings";

const MAX_BYTES = 50 * 1024 * 1024;
const TMP_DIR = path.join(DATA_DIR, "imports", "tmp");

// Parse an uploaded file, stash it for the run step, return preview data.
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
  const text = buf.toString("utf8");
  const sha = crypto.createHash("sha256").update(buf).digest("hex");

  const isVcf =
    /\.vcf$/i.test(file.name) || /^\s*BEGIN:VCARD/i.test(text.slice(0, 200));

  const token = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(path.join(TMP_DIR, token), buf);
  fs.writeFileSync(
    path.join(TMP_DIR, `${token}.meta.json`),
    JSON.stringify({ fileName: path.basename(file.name), sha })
  );

  if (isVcf) {
    const cards = parseVcards(text);
    return NextResponse.json({
      token,
      kind: "vcard",
      totalRows: cards.length,
      sample: cards.slice(0, 5).map((c) => ({
        name:
          [c.firstName, c.lastName].filter(Boolean).join(" ") ||
          c.fullName ||
          c.emails[0]?.email ||
          "(unnamed)",
        company: c.company ?? "",
        emails: c.emails.length,
      })),
    });
  }

  const table = parseCsv(text);
  if (table.headers.length === 0) {
    return NextResponse.json({ error: "empty file" }, { status: 400 });
  }
  const signature = headerSignature(table.headers);
  const savedMapping = getSetting<Mapping>(`import.mapping.${signature}`);
  return NextResponse.json({
    token,
    kind: "csv",
    headers: table.headers,
    totalRows: table.rows.length,
    sampleRows: table.rows.slice(0, 5),
    suggestedMapping: savedMapping ?? guessMapping(table.headers),
    usedSavedTemplate: Boolean(savedMapping),
    signature,
  });
}
