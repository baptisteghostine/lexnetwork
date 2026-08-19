// Bulk merge (SPEC §10): merge many suggestion-queue pairs in one go with
// default field decisions. The careful per-field merge screen stays the
// path for pairs that need judgment; this is for the after-import moment
// when the queue holds a page of obvious duplicates.

import type { Database } from "better-sqlite3";

import { mergeContacts } from "./merge";

export type BulkMergeResult = {
  merged: { pairId: number; winnerId: number; loserId: number; logId: number }[];
  skipped: { pairId: number; reason: string }[];
};

const PROFILE_FIELDS = [
  "first_name",
  "last_name",
  "title",
  "company",
  "location",
  "bio",
  "description_md",
  "photo_path",
  "birthday_month",
] as const;

const CHILD_COUNTS = [
  "contact_emails",
  "contact_phones",
  "contact_socials",
  "work_history",
  "notes",
  "interactions",
] as const;

/**
 * How much is known about a contact — filled profile fields plus child
 * rows. Drives the bulk winner choice: on a field conflict the winner's
 * value survives, so the contact carrying more information should be the
 * one whose values win by default.
 */
export function dataRichness(db: Database, contactId: number): number {
  const row = db
    .prepare(
      `SELECT ${PROFILE_FIELDS.map((f) => `"${f}"`).join(", ")}
       FROM contacts WHERE id = ?`
    )
    .get(contactId) as Record<string, unknown> | undefined;
  if (!row) return -1;
  let score = PROFILE_FIELDS.filter(
    (f) => row[f] !== null && row[f] !== ""
  ).length;
  for (const table of CHILD_COUNTS) {
    const n = db
      .prepare(`SELECT count(*) AS n FROM "${table}" WHERE contact_id = ?`)
      .get(contactId) as { n: number };
    score += n.n;
  }
  return score;
}

/**
 * Owner-confirmed rule: the contact with more data wins; tie goes to the
 * older contact (earlier created_at, then smaller id — insertion order).
 * Multi-value data (emails, notes, interactions…) is unioned either way;
 * this only decides whose value survives a scalar conflict.
 */
export function pickBulkWinner(
  db: Database,
  aId: number,
  bId: number
): { winnerId: number; loserId: number } {
  const richnessA = dataRichness(db, aId);
  const richnessB = dataRichness(db, bId);
  if (richnessA !== richnessB) {
    return richnessA > richnessB
      ? { winnerId: aId, loserId: bId }
      : { winnerId: bId, loserId: aId };
  }
  const created = (id: number) =>
    (
      db.prepare("SELECT created_at FROM contacts WHERE id = ?").get(id) as
        | { created_at: number }
        | undefined
    )?.created_at ?? Number.MAX_SAFE_INTEGER;
  const createdA = created(aId);
  const createdB = created(bId);
  if (createdA !== createdB) {
    return createdA < createdB
      ? { winnerId: aId, loserId: bId }
      : { winnerId: bId, loserId: aId };
  }
  return aId < bId
    ? { winnerId: aId, loserId: bId }
    : { winnerId: bId, loserId: aId };
}

/**
 * Merge the given open pairs sequentially. A pair whose contact was
 * already merged away earlier in the same batch (chained selections like
 * A–B and B–C) is skipped and reported, never silently re-routed — the
 * next scan re-scores the merged reality (owner-confirmed rule #3). Each
 * merge is its own transaction and its own undoable merge_log row.
 */
export function bulkMergePairs(
  db: Database,
  pairIds: number[]
): BulkMergeResult {
  const result: BulkMergeResult = { merged: [], skipped: [] };
  for (const pairId of pairIds) {
    const pair = db
      .prepare(
        "SELECT id, contact_a_id, contact_b_id, status FROM duplicate_candidates WHERE id = ?"
      )
      .get(pairId) as
      | { id: number; contact_a_id: number; contact_b_id: number; status: string }
      | undefined;
    if (!pair) {
      // Cascaded away when one of its contacts lost an earlier merge.
      result.skipped.push({
        pairId,
        reason: "contact was already merged in this batch — re-scan to re-evaluate",
      });
      continue;
    }
    if (pair.status !== "open") {
      result.skipped.push({ pairId, reason: `pair is ${pair.status}` });
      continue;
    }
    const { winnerId, loserId } = pickBulkWinner(
      db,
      pair.contact_a_id,
      pair.contact_b_id
    );
    try {
      const { logId } = mergeContacts(db, { winnerId, loserId });
      result.merged.push({ pairId, winnerId, loserId, logId });
    } catch (err) {
      result.skipped.push({
        pairId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
