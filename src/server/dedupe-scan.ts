import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db/client";
import {
  contactEmails,
  contactPhones,
  contacts,
  duplicateCandidates,
  groupMembers,
  syncRuns,
} from "@/db/schema";
import {
  candidatePairs,
  planQueueUpdate,
  type ExistingPair,
  type MatchableContact,
} from "@/lib/dedupe/matcher";

// The dedupe scan (SPEC §10): score all active contacts, reconcile the
// suggestion queue. Runs daily via the scheduler and on demand from the
// duplicates page. Pure scoring lives in lib/dedupe/matcher; this file is
// the DB glue.

export type DedupeScanStats = {
  contactsScanned: number;
  pairsFound: number;
  added: number;
  refreshed: number;
  removedStale: number;
};

function loadMatchable(): MatchableContact[] {
  const rows = db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      displayName: contacts.displayName,
      company: contacts.company,
    })
    .from(contacts)
    .where(isNull(contacts.archivedAt))
    .all();
  const byId = new Map<number, MatchableContact>(
    rows.map((r) => [
      r.id,
      { ...r, emailsNormalized: [], phonesE164: [], groupIds: [] },
    ])
  );
  for (const e of db
    .select({ contactId: contactEmails.contactId, v: contactEmails.emailNormalized })
    .from(contactEmails)
    .all()) {
    byId.get(e.contactId)?.emailsNormalized.push(e.v);
  }
  for (const p of db
    .select({ contactId: contactPhones.contactId, v: contactPhones.phoneE164 })
    .from(contactPhones)
    .all()) {
    if (p.v) byId.get(p.contactId)?.phonesE164.push(p.v);
  }
  for (const g of db
    .select({ contactId: groupMembers.contactId, v: groupMembers.groupId })
    .from(groupMembers)
    .all()) {
    byId.get(g.contactId)?.groupIds.push(g.v);
  }
  return [...byId.values()];
}

/** One full scan + queue reconciliation. Records a sync_runs row. */
export function runDedupeScan(): DedupeScanStats {
  const startedAt = Date.now();
  const runId = db
    .insert(syncRuns)
    .values({ kind: "dedupe_scan", status: "running", startedAt })
    .returning({ id: syncRuns.id })
    .get().id;

  try {
    const matchable = loadMatchable();
    const found = candidatePairs(matchable);
    const existing = db
      .select({
        aId: duplicateCandidates.contactAId,
        bId: duplicateCandidates.contactBId,
        status: duplicateCandidates.status,
      })
      .from(duplicateCandidates)
      .all() as ExistingPair[];

    const plan = planQueueUpdate(existing, found);
    const now = Date.now();
    for (const pair of plan.insert) {
      db.insert(duplicateCandidates)
        .values({
          contactAId: pair.aId,
          contactBId: pair.bId,
          score: pair.score,
          reasonsJson: JSON.stringify(pair.reasons),
          status: "open",
          createdAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
    for (const pair of plan.update) {
      db.update(duplicateCandidates)
        .set({ score: pair.score, reasonsJson: JSON.stringify(pair.reasons) })
        .where(
          and(
            eq(duplicateCandidates.contactAId, pair.aId),
            eq(duplicateCandidates.contactBId, pair.bId),
            eq(duplicateCandidates.status, "open")
          )
        )
        .run();
    }
    for (const pair of plan.remove) {
      db.delete(duplicateCandidates)
        .where(
          and(
            eq(duplicateCandidates.contactAId, pair.aId),
            eq(duplicateCandidates.contactBId, pair.bId),
            eq(duplicateCandidates.status, "open")
          )
        )
        .run();
    }

    const stats: DedupeScanStats = {
      contactsScanned: matchable.length,
      pairsFound: found.length,
      added: plan.insert.length,
      refreshed: plan.update.length,
      removedStale: plan.remove.length,
    };
    db.update(syncRuns)
      .set({
        status: "success",
        statsJson: JSON.stringify(stats),
        finishedAt: Date.now(),
      })
      .where(eq(syncRuns.id, runId))
      .run();
    return stats;
  } catch (err) {
    db.update(syncRuns)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        finishedAt: Date.now(),
      })
      .where(eq(syncRuns.id, runId))
      .run();
    throw err;
  }
}
