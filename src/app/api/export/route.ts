import fs from "node:fs";
import path from "node:path";

import { strToU8, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { NextResponse } from "next/server";

import { DATA_DIR, rawDb } from "@/db/client";
import { isAuthenticated } from "@/lib/auth";
import {
  contactsCsvChunks,
  listExportTables,
  tableJsonChunks,
  tableRowCount,
  type ExportManifest,
} from "@/lib/export/build";

// One click → everything, streamed (SPEC §13). The ZIP is produced by an
// async generator so a 50k-contact database (or a fat attachments folder)
// never sits in memory: each push into the archive drains straight into
// the response stream.

function* walkFiles(dir: string, rel = ""): Generator<{ abs: string; rel: string }> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walkFiles(abs, relPath);
    else if (entry.isFile()) yield { abs, rel: relPath };
  }
}

async function* zipChunks(runId: number): AsyncGenerator<Uint8Array> {
  const pending: Uint8Array[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((err, dat) => {
    if (err) zipError = err instanceof Error ? err : new Error(String(err));
    else if (dat.length > 0) pending.push(dat);
  });
  function* drain(): Generator<Uint8Array> {
    if (zipError) throw zipError;
    while (pending.length > 0) yield pending.shift()!;
  }

  const stats = { tables: 0, rows: 0, attachments: 0 };
  const manifest: ExportManifest = {
    exportedAt: Date.now(),
    format: 1,
    tables: [],
    attachmentsIncluded: false,
  };

  try {
    // contacts.csv — the human-readable, re-importable flat view.
    const csv = new ZipDeflate("contacts.csv", { level: 6 });
    zip.add(csv);
    for (const chunk of contactsCsvChunks(rawDb)) {
      csv.push(strToU8(chunk));
      yield* drain();
    }
    csv.push(new Uint8Array(0), true);
    yield* drain();

    // tables/*.json — full fidelity, one file per table.
    for (const table of listExportTables(rawDb)) {
      const rows = tableRowCount(rawDb, table);
      manifest.tables.push({ name: table, rows });
      stats.tables += 1;
      stats.rows += rows;
      const file = new ZipDeflate(`tables/${table}.json`, { level: 6 });
      zip.add(file);
      for (const chunk of tableJsonChunks(rawDb, table)) {
        file.push(strToU8(chunk));
        yield* drain();
      }
      file.push(new Uint8Array(0), true);
      yield* drain();
    }

    // attachments/ — notes' files and contact photos, byte-for-byte.
    const attachmentsDir = path.join(DATA_DIR, "attachments");
    if (fs.existsSync(attachmentsDir)) {
      manifest.attachmentsIncluded = true;
      for (const f of walkFiles(attachmentsDir)) {
        // Images and PDFs are already compressed — store, don't deflate.
        const entry = new ZipPassThrough(`attachments/${f.rel}`);
        zip.add(entry);
        const handle = fs.createReadStream(f.abs);
        for await (const chunk of handle) {
          entry.push(chunk as Uint8Array);
          yield* drain();
        }
        entry.push(new Uint8Array(0), true);
        stats.attachments += 1;
        yield* drain();
      }
    }

    const manifestFile = new ZipDeflate("manifest.json", { level: 6 });
    zip.add(manifestFile);
    manifestFile.push(strToU8(JSON.stringify(manifest, null, 2)), true);
    zip.end();
    yield* drain();

    rawDb
      .prepare(
        "UPDATE sync_runs SET status = 'success', stats_json = ?, finished_at = ? WHERE id = ?"
      )
      .run(JSON.stringify(stats), Date.now(), runId);
  } catch (err) {
    rawDb
      .prepare(
        "UPDATE sync_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?"
      )
      .run(err instanceof Error ? err.message : String(err), Date.now(), runId);
    throw err;
  }
}

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();
  const run = rawDb
    .prepare(
      "INSERT INTO sync_runs (kind, status, started_at) VALUES ('export', 'running', ?)"
    )
    .run(startedAt);
  const iterator = zipChunks(Number(run.lastInsertRowid));
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
      // The generator never got to finish — don't leave the run 'running'.
      rawDb
        .prepare(
          "UPDATE sync_runs SET status = 'failed', error = 'download cancelled', finished_at = ? WHERE id = ? AND status = 'running'"
        )
        .run(Date.now(), Number(run.lastInsertRowid));
    },
  });
  const stamp = new Date(startedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return new Response(stream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="rolo-export-${stamp}.zip"`,
      "cache-control": "no-store",
    },
  });
}
