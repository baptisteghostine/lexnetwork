import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  backupFileName,
  parseBackupTimestamp,
  readBackupStatus,
  runBackup,
  selectPrunable,
} from "@/lib/backup/run";

const MIGRATIONS_DIR = path.join(__dirname, "../../../src/db/migrations");
const NOW = Date.UTC(2026, 7, 14, 3, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function migrate(target: Database.Database): void {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")
  ) as { entries: { tag: string }[] };
  for (const entry of journal.entries) {
    const sqlText = fs.readFileSync(
      path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
      "utf8"
    );
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

let db: Database.Database;
let dataDir: string;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  db.prepare(
    `INSERT INTO contacts (display_name, created_at, updated_at) VALUES ('Ana Silva', ?, ?)`
  ).run(NOW, NOW);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rolo-backup-test-"));
});

afterEach(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("prune rule (pure)", () => {
  it("prunes only backup-named files older than 30 days", () => {
    const fresh = backupFileName(NOW - 5 * DAY);
    const stale = backupFileName(NOW - 31 * DAY);
    const boundary = backupFileName(NOW - 30 * DAY + 60_000);
    const foreign = "my-manual-copy.db";
    expect(selectPrunable([fresh, stale, boundary, foreign], NOW)).toEqual([
      stale,
    ]);
  });

  it("filename timestamps round-trip", () => {
    expect(parseBackupTimestamp(backupFileName(NOW))).toBe(NOW);
    expect(parseBackupTimestamp("rolo.db")).toBeNull();
  });
});

describe("runBackup", () => {
  it("VACUUMs into a timestamped file that is a working database", () => {
    const result = runBackup(db, dataDir, NOW);
    const file = path.join(dataDir, "backups", result.fileName);
    expect(fs.existsSync(file)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);

    const restored = new Database(file, { readonly: true });
    const rows = restored.prepare("SELECT display_name FROM contacts").all() as {
      display_name: string;
    }[];
    restored.close();
    expect(rows).toEqual([{ display_name: "Ana Silva" }]);
  });

  it("two nightly runs leave two files; a 31-day-old file is pruned (SPEC §13 AC)", () => {
    const backupsDir = path.join(dataDir, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    const old = backupFileName(NOW - 31 * DAY);
    fs.writeFileSync(path.join(backupsDir, old), "stale");

    runBackup(db, dataDir, NOW);
    runBackup(db, dataDir, NOW + DAY);

    const files = fs.readdirSync(backupsDir).sort();
    expect(files).toEqual([backupFileName(NOW), backupFileName(NOW + DAY)]);
  });

  it("records success status readable by the settings panel", () => {
    const result = runBackup(db, dataDir, NOW);
    const status = readBackupStatus(db);
    expect(status.failing).toBe(false);
    expect(status.lastFileName).toBe(result.fileName);
    expect(status.lastSizeBytes).toBe(result.sizeBytes);
    expect(status.lastSuccessAt).toBeGreaterThanOrEqual(NOW);
    expect(status.lastFailure).toBeNull();
  });

  it("a failed run is recorded, rethrown, and flips the banner flag", () => {
    // Unwritable target directory → VACUUM INTO fails.
    fs.writeFileSync(path.join(dataDir, "backups"), "not a directory");
    expect(() => runBackup(db, dataDir, NOW)).toThrow();
    const status = readBackupStatus(db);
    expect(status.failing).toBe(true);
    expect(status.lastFailure?.error).toBeTruthy();
    // A later success clears the banner but keeps history.
    fs.rmSync(path.join(dataDir, "backups"));
    runBackup(db, dataDir, NOW + DAY);
    expect(readBackupStatus(db).failing).toBe(false);
  });
});
