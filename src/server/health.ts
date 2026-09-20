import "server-only";

import { and, inArray } from "drizzle-orm";

import { db, rawDb } from "@/db/client";
import { integrationAccounts, jobs } from "@/db/schema";
import { readBackupStatus } from "@/lib/backup/run";
import { buildHealthIssues, JOB_LABELS, type HealthIssue } from "@/lib/health";

/**
 * Everything the app-wide banner has to say (SPEC §13, widened
 * 2026-09-19). Read on every page render, so it is three indexed reads:
 * the backup status, the integration accounts, and the terminal job rows
 * of the labelled kinds (pruned after a week, so the table stays small).
 */
export function readHealthIssues(): HealthIssue[] {
  const accounts = db
    .select({
      provider: integrationAccounts.provider,
      status: integrationAccounts.status,
      lastError: integrationAccounts.lastError,
    })
    .from(integrationAccounts)
    .all();
  const terminal = db
    .select({
      kind: jobs.kind,
      status: jobs.status,
      finishedAt: jobs.finishedAt,
      lastError: jobs.lastError,
    })
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, ["success", "dead"]),
        inArray(jobs.kind, Object.keys(JOB_LABELS))
      )
    )
    .all();
  return buildHealthIssues({
    backupFailing: readBackupStatus(rawDb).failing,
    accounts,
    jobs: terminal,
  });
}
