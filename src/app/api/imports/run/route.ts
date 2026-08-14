import fs from "node:fs";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { DATA_DIR } from "@/db/client";
import { isAuthenticated } from "@/lib/auth";
import { parseCsv } from "@/lib/imports/csv";
import {
  applyMapping,
  MAPPING_TARGETS,
  type Mapping,
} from "@/lib/imports/mapping";
import { parseVcards } from "@/lib/imports/vcard";
import { getSetting, setSetting } from "@/lib/settings";
import { executeImport } from "@/server/import-engine";

const TMP_DIR = path.join(DATA_DIR, "imports", "tmp");

const runInput = z.object({
  token: z.string().regex(/^[0-9a-f]{32}$/),
  kind: z.enum(["csv", "vcard"]),
  mapping: z.array(z.enum(MAPPING_TARGETS)).optional(),
  signature: z.string().optional(),
  dryRun: z.boolean(),
  force: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = runInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { token, kind, mapping, signature, dryRun, force } = parsed.data;

  const filePath = path.join(TMP_DIR, token);
  const metaPath = path.join(TMP_DIR, `${token}.meta.json`);
  if (!fs.existsSync(filePath) || !fs.existsSync(metaPath)) {
    return NextResponse.json(
      { error: "upload expired — start over" },
      { status: 410 }
    );
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
    fileName: string;
    sha: string;
  };
  const text = fs.readFileSync(filePath, "utf8");

  let rows;
  if (kind === "vcard") {
    rows = parseVcards(text);
  } else {
    if (!mapping) {
      return NextResponse.json({ error: "mapping required" }, { status: 400 });
    }
    const table = parseCsv(text);
    // Slashed birthday dates follow the owner's region: a non-US phone
    // region reads 07/03 as 7 March (day-first), matching how the owner's
    // exports are actually written.
    const region = getSetting<string>("phone_default_region");
    rows = applyMapping(table.headers, table.rows, mapping as Mapping, {
      dmyDates: !!region && region !== "US",
    });
  }

  const result = executeImport({
    rows,
    kind: kind === "vcard" ? "vcard_import" : "csv_import",
    fileName: meta.fileName,
    fileSha256: meta.sha,
    mappingJson: mapping ? JSON.stringify(mapping) : undefined,
    dryRun,
    force,
  });

  if ("duplicateOf" in result) {
    return NextResponse.json({ duplicateOf: result.duplicateOf });
  }

  if (!dryRun) {
    // Remember the mapping for this header shape; clean up the upload.
    if (mapping && signature) {
      setSetting(`import.mapping.${signature}`, mapping);
    }
    fs.rmSync(filePath, { force: true });
    fs.rmSync(metaPath, { force: true });
    return NextResponse.json({ runId: result.runId, stats: result.stats });
  }
  return NextResponse.json({
    stats: result.stats,
    // Preview payload trimmed: the report page shows full detail post-run.
    plans: result.plans.slice(0, 200).map((p) => ({
      status: p.status,
      displayName: p.displayName,
      matchedBy: p.matchedBy,
      writes: p.writes,
      conflicts: p.conflicts,
      newEmails: p.newEmails.length,
      newPhones: p.newPhones.length,
      error: p.error,
    })),
  });
}
