import path from "node:path";

import Database from "better-sqlite3";
import type { Page } from "playwright/test";

export const E2E_PASSWORD = "e2e-test-password";

/**
 * Direct handle on the server's database — the E2E equivalent of the seed
 * script's backdate helper (PLAN Phase 4 manual check): cadences only make
 * a contact *due* days after assignment, so tests that need a populated
 * Today queue backdate through here instead of waiting a week.
 */
export function openE2eDb(): Database.Database {
  return new Database(path.join(__dirname, ".data/rolo.db"));
}

export function backdateCadence(displayName: string, cadenceDays = 7): void {
  const db = openE2eDb();
  try {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const info = db
      .prepare(
        `UPDATE contacts
         SET cadence_days = ?, cadence_assigned_at = ?, next_touch_at = ?
         WHERE display_name = ?`
      )
      .run(cadenceDays, now - (cadenceDays + 3) * day, now - 3 * day, displayName);
    if (info.changes !== 1) {
      throw new Error(
        `backdateCadence: expected 1 contact named '${displayName}', matched ${info.changes}`
      );
    }
  } finally {
    db.close();
  }
}

/** Autosave is debounced with no reliable UI transition to await (the
 * indicator starts out reading "saved") — poll the database instead. */
export function noteExists(bodyMd: string): boolean {
  const db = openE2eDb();
  try {
    const row = db
      .prepare("SELECT id FROM notes WHERE body_md = ?")
      .get(bodyMd);
    return row !== undefined;
  } finally {
    db.close();
  }
}

/** The contact form's labels aren't wired with htmlFor — target the
 * label's field wrapper instead. */
export function fieldInput(page: Page, label: string) {
  return page
    .locator(`div:has(> label:text-is("${label}"))`)
    .locator("input, textarea")
    .first();
}
