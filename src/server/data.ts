"use server";

import { revalidatePath } from "next/cache";

import { DATA_DIR, rawDb } from "@/db/client";
import { requireAuth } from "@/lib/auth";
import { readBackupStatus, runBackup, type BackupStatus } from "@/lib/backup/run";

// Settings → Data: export + backup status (SPEC §13). Logic lives in
// lib/backup; this file is the thin auth-gated surface.

export type DataStatus = {
  backup: BackupStatus;
  lastExport: { at: number; status: string; error: string | null } | null;
};

export async function readDataStatus(): Promise<DataStatus> {
  await requireAuth();
  const lastExport = rawDb
    .prepare<[], { started_at: number; status: string; error: string | null }>(
      `SELECT started_at, status, error FROM sync_runs
       WHERE kind = 'export' ORDER BY started_at DESC LIMIT 1`
    )
    .get();
  return {
    backup: readBackupStatus(rawDb),
    lastExport: lastExport
      ? {
          at: lastExport.started_at,
          status: lastExport.status,
          error: lastExport.error,
        }
      : null,
  };
}

export type BackupNowState = { error?: string; fileName?: string };

export async function backupNowAction(): Promise<BackupNowState> {
  await requireAuth();
  try {
    const result = runBackup(rawDb, DATA_DIR);
    revalidatePath("/settings");
    return { fileName: result.fileName };
  } catch (err) {
    revalidatePath("/settings");
    return { error: err instanceof Error ? err.message : "Backup failed." };
  }
}
