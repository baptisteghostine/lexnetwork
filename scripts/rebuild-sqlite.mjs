// Rebuild a clean SQLite file from a damaged one, table by table.
//
// For "database disk image is malformed" (SQLITE_CORRUPT) when the tables
// themselves still read: copies every table's rows into a fresh file,
// recreates indexes and triggers, rebuilds the FTS5 indexes from their
// content tables, and refuses to call the result clean unless every row
// count matches and integrity_check passes. Reads only from the source.
//
// Plain JavaScript (ES module) on purpose: this has to run inside the production image
// with nothing but node and the app's own better-sqlite3 — no tsx there.
//
//   docker compose run --rm --no-deps --entrypoint node rolo /app/data/rebuild.mjs
//
// (copy this file to data/rebuild.mjs first; see DEPLOY.md "Corrupt database").
// Arguments: [source.db] [dest.db], defaulting to the container's data dir.
import D from "better-sqlite3";
import fs from "node:fs";

const SRC = process.argv[2] || "/app/data/rolo.db";
const DST = process.argv[3] || "/app/data/rolo-rebuilt.db";
for (const f of [DST, DST + "-wal", DST + "-shm", DST + "-journal"]) fs.rmSync(f, { force: true });

const src = new D(SRC);
const dst = new D(DST);
dst.pragma("foreign_keys = OFF");

const master = src
  .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid")
  .all();
const isVirtual = (r) => r.type === "table" && /^CREATE VIRTUAL TABLE/i.test(r.sql.trim());
const fts = master.filter(isVirtual).map((r) => r.name);
const isShadow = (n) => fts.some((f) => n.startsWith(f + "_"));
const tables = master.filter(
  (r) => r.type === "table" && !isVirtual(r) && !isShadow(r.name) && !r.name.startsWith("sqlite_")
);

console.log("schema: " + tables.length + " tables, " + fts.length + " fts tables");
for (const t of tables) dst.exec(t.sql);
for (const r of master.filter(isVirtual)) dst.exec(r.sql);

const report = [];
let failures = 0;
for (const t of tables) {
  const cols = src.pragma(`table_info("${t.name}")`).map((c) => c.name);
  const q = (n) => `"${n.replace(/"/g, '""')}"`;
  const insert = dst.prepare(
    `INSERT INTO ${q(t.name)} (${cols.map(q).join(",")}) VALUES (${cols.map(() => "?").join(",")})`
  );
  let expected = null;
  try {
    expected = src.prepare(`SELECT count(*) AS n FROM ${q(t.name)}`).get().n;
  } catch {
    // count may fail on a broken index; row scan below still tries
  }
  let copied = 0;
  let error = null;
  const tx = dst.transaction(() => {
    const it = src.prepare(`SELECT ${cols.map(q).join(",")} FROM ${q(t.name)}`).raw().iterate();
    try {
      for (const row of it) {
        insert.run(row);
        copied++;
      }
    } catch (e) {
      error = e.message;
    }
  });
  tx();
  const ok = error === null && (expected === null || expected === copied);
  if (!ok) failures++;
  report.push(`  ${ok ? "ok  " : "FAIL"} ${t.name}: ${copied}${expected !== null ? "/" + expected : ""}${error ? " — " + error : ""}`);
}
console.log("rows:");
for (const line of report) console.log(line);

// sqlite_sequence only exists when a table uses AUTOINCREMENT
try {
  const seq = src.prepare("SELECT name, seq FROM sqlite_sequence").all();
  const has = dst.prepare("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'").get();
  if (has) {
    const up = dst.prepare("INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES (?, ?)");
    for (const s of seq) up.run(s.name, s.seq);
    console.log("sqlite_sequence: " + seq.length + " rows");
  }
} catch {
  // no sqlite_sequence in the source — nothing to carry over
}

for (const r of master.filter((r) => r.type === "index")) dst.exec(r.sql);
for (const r of master.filter((r) => r.type === "view")) dst.exec(r.sql);
for (const r of master.filter((r) => r.type === "trigger")) dst.exec(r.sql);
for (const f of fts) {
  dst.exec(`INSERT INTO "${f}"("${f}") VALUES ('rebuild')`);
  console.log(`fts rebuilt: ${f} (${dst.prepare(`SELECT count(*) AS n FROM "${f}"`).get().n} rows)`);
}
src.close();

dst.pragma("foreign_keys = ON");
const fk = dst.pragma("foreign_key_check");
console.log("foreign_key_check: " + (fk.length === 0 ? "ok" : fk.length + " violations"));
const ic = dst.pragma("integrity_check");
console.log("integrity_check: " + ic.map((r) => r.integrity_check).join("; "));
dst.close();

const clean = fk.length === 0 && ic.length === 1 && ic[0].integrity_check === "ok" && failures === 0;
console.log(clean ? "RESULT: clean rebuild at " + DST : "RESULT: rebuild has problems — do not swap yet");
process.exit(clean ? 0 : 1);
