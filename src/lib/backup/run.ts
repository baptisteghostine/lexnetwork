// Nightly backups (SPEC §13): `VACUUM INTO` a timestamped file under
// data/backups/, prune to 30 days. VACUUM INTO writes a compact,
// consistent snapshot without blocking readers — the canonical SQLite
// online-backup method for a WAL database.

import fs from "node:fs";
import path from "node:path";

import type { Database } from "better-sqlite3";

export const KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function backupFileName(now: number): string {
  // UTC timestamp in the name — sortable, and restores are unambiguous
  // even if the owner's timezone setting changes.
  const d = new Date(now);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `rolo-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.db`
  );
}

export function parseBackupTimestamp(name: string): number | null {
  const m = /^rolo-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/.exec(name);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Which files to delete. Pure — the prune rule is unit-tested without a
 * filesystem. Only files matching the backup name pattern are ever
 * candidates: a stray file the owner dropped into data/backups/ is not
 * ours to delete.
 */
export function selectPrunable(
  names: string[],
  now: number,
  keepDays: number = KEEP_DAYS
): string[] {
  const cutoff = now - keepDays * DAY_MS;
  return names.filter((name) => {
    const ts = parseBackupTimestamp(name);
    return ts !== null && ts < cutoff;
  });
}

export type BackupResult = {
  fileName: string;
  sizeBytes: number;
  pruned: string[];
};

/**
 * Take one backup and prune old ones. Records its own sync_runs row
 * (kind 'backup') so the settings panel and the failure banner have a
 * durable status to read; failures are recorded AND rethrown so the job
 * scheduler also retries with backoff (fail loud).
 */
export function runBackup(
  db: Database,
  dataDir: string,
  now: number = Date.now()
): BackupResult {
  const runId = Number(
    db
      .prepare(
        "INSERT INTO sync_runs (kind, status, started_at) VALUES ('backup', 'running', ?)"
      )
      .run(now).lastInsertRowid
  );
  try {
    const backupsDir = path.join(dataDir, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    const fileName = backupFileName(now);
    const target = path.join(backupsDir, fileName);
    // A crashed previous run may have left a partial file with this name
    // (same second) — VACUUM INTO refuses to overwrite.
    fs.rmSync(target, { force: true });
    db.prepare("VACUUM INTO ?").run(target);
    const sizeBytes = fs.statSync(target).size;

    const pruned = selectPrunable(fs.readdirSync(backupsDir), now).filter(
      (name) => name !== fileName
    );
    for (const name of pruned) {
      fs.rmSync(path.join(backupsDir, name), { force: true });
    }

    db.prepare(
      "UPDATE sync_runs SET status = 'success', stats_json = ?, finished_at = ? WHERE id = ?"
    ).run(
      JSON.stringify({ fileName, sizeBytes, pruned: pruned.length }),
      Date.now(),
      runId
    );
    return { fileName, sizeBytes, pruned };
  } catch (err) {
    db.prepare(
      "UPDATE sync_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?"
    ).run(err instanceof Error ? err.message : String(err), Date.now(), runId);
    throw err;
  }
}

export type BackupStatus = {
  lastSuccessAt: number | null;
  lastSizeBytes: number | null;
  lastFileName: string | null;
  lastFailure: { at: number; error: string } | null;
  /** True when the most recent finished run failed — drives the banner. */
  failing: boolean;
};

export function readBackupStatus(db: Database): BackupStatus {
  const last = db
    .prepare<[], { status: string; stats_json: string | null; error: string | null; finished_at: number | null }>(
      `SELECT status, stats_json, error, finished_at FROM sync_runs
       WHERE kind = 'backup' AND status IN ('success', 'failed')
       ORDER BY started_at DESC LIMIT 1`
    )
    .get();
  const lastSuccess = db
    .prepare<[], { stats_json: string | null; finished_at: number | null }>(
      `SELECT stats_json, finished_at FROM sync_runs
       WHERE kind = 'backup' AND status = 'success'
       ORDER BY started_at DESC LIMIT 1`
    )
    .get();
  const stats = lastSuccess?.stats_json
    ? (JSON.parse(lastSuccess.stats_json) as { fileName?: string; sizeBytes?: number })
    : null;
  return {
    lastSuccessAt: lastSuccess?.finished_at ?? null,
    lastSizeBytes: stats?.sizeBytes ?? null,
    lastFileName: stats?.fileName ?? null,
    lastFailure:
      last && last.status === "failed"
        ? { at: last.finished_at ?? 0, error: last.error ?? "unknown error" }
        : null,
    failing: last?.status === "failed",
  };
}
