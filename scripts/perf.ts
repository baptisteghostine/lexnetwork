// Phase 11 performance pass: time the hot paths against whatever database
// ROLO_DATA_DIR points at (pair with `npm run seed -- --count 10000`).
// Usage: ROLO_DATA_DIR=... npx tsx scripts/perf.ts

import { rawDb, DATA_DIR } from "../src/db/client";
import { runBackup } from "../src/lib/backup/run";
import {
  contactsCsvChunks,
  listExportTables,
  tableJsonChunks,
} from "../src/lib/export/build";
import { bucketFor, bucketId } from "../src/lib/cadence/engine";
import { compileFilter } from "../src/lib/filters/compile";
import { emptyFilterSet } from "../src/lib/filters/types";
import { runDedupeScan } from "../src/server/dedupe-scan";
import { searchAll } from "../src/server/search";
import { getTodayData } from "../src/server/today-data";

function time<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms`);
  return out;
}

const n = rawDb.prepare("SELECT count(*) AS n FROM contacts").get() as {
  n: number;
};
console.log(`contacts: ${n.n}  (${DATA_DIR})\n`);

// The contacts page path minus the request-scoped auth check: compile the
// (empty) filter, run its SQL, cap at the page limit (see runFilter).
const list = time("contacts page (filter engine, limit 500)", () => {
  const catalog = {
    tagIds: new Set<number>(),
    groupIds: new Set<number>(),
    customFieldIds: new Set<number>(),
    geocoderConfigured: false,
  };
  const compiled = compileFilter(emptyFilterSet(), {
    now: Date.now(),
    sort: { key: "name", dir: "asc" },
    catalog,
  });
  const rows = rawDb
    .prepare(compiled.sql)
    .all(...(compiled.params as unknown[])) as { id: number }[];
  return { total: rows.length, page: rows.slice(0, 500).length };
});
console.log(`  → ${list.page} rows of ${list.total}`);

const today = time("Today page data", () => getTodayData(Date.now()));
console.log(`  → ${today.dueContacts.length} due contacts`);

// The keep-in-touch board reads every non-archived contact and buckets in
// TS (SPEC §3a) — mirrored here without the request-scoped auth check.
const board = time("keep-in-touch board (bucket all)", () => {
  const rows = rawDb
    .prepare(
      `SELECT id, display_name, cadence_days, cadence_reviewed_at
       FROM contacts WHERE archived_at IS NULL`
    )
    .all() as {
    cadence_days: number | null;
    cadence_reviewed_at: number | null;
  }[];
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = bucketId(
      bucketFor({
        cadenceDays: r.cadence_days,
        cadenceReviewedAt: r.cadence_reviewed_at,
      })
    );
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
});
console.log(
  `  → ${[...board].map(([k, n]) => `${k}:${n}`).join(" ")}`
);

const s1 = time("search 'ander' (FTS + re-rank)", () => searchAll("ander"));
console.log(`  → ${s1.contacts.length} contact hits`);

const s2 = time("search 'quintana berlin'", () => searchAll("quintana berlin"));
console.log(`  → ${s2.contacts.length} contact hits`);

time("dedupe scan (full)", () => runDedupeScan());

const csvBytes = time("export: contacts.csv stream", () => {
  let bytes = 0;
  for (const chunk of contactsCsvChunks(rawDb)) bytes += chunk.length;
  return bytes;
});
console.log(`  → ${(csvBytes / 1024).toFixed(0)} KiB`);

const jsonBytes = time("export: all table JSON streams", () => {
  let bytes = 0;
  for (const t of listExportTables(rawDb)) {
    for (const chunk of tableJsonChunks(rawDb, t)) bytes += chunk.length;
  }
  return bytes;
});
console.log(`  → ${(jsonBytes / 1024).toFixed(0)} KiB`);

time("backup (VACUUM INTO + prune)", () => runBackup(rawDb, DATA_DIR));
