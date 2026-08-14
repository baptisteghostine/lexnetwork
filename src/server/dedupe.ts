"use server";

import { desc, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db, rawDb } from "@/db/client";
import {
  contactEmails,
  contacts,
  duplicateCandidates,
  mergeLog,
} from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import {
  defaultDecisions,
  MERGE_FIELDS,
  mergeContacts,
  undoMerge,
  type MergeDecisions,
  type MergeField,
} from "@/lib/dedupe/merge";
import { runDedupeScan } from "@/server/dedupe-scan";

// Server actions + data for the duplicates queue and merge screen.
// Thin by design (CLAUDE.md): scoring lives in lib/dedupe/matcher, the
// merge transaction in lib/dedupe/merge, scan glue in server/dedupe-scan.

export type ContactSummary = {
  id: number;
  displayName: string;
  company: string | null;
  title: string | null;
  email: string | null;
  archived: boolean;
};

export type DuplicatePair = {
  id: number;
  score: number;
  reasons: string[];
  a: ContactSummary;
  b: ContactSummary;
};

export type RecentMerge = {
  logId: number;
  winnerId: number;
  winnerName: string;
  loserName: string;
  mergedAt: number;
};

function summaries(ids: number[]): Map<number, ContactSummary> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      company: contacts.company,
      title: contacts.title,
      archivedAt: contacts.archivedAt,
    })
    .from(contacts)
    .where(inArray(contacts.id, ids))
    .all();
  const emails = db
    .select({ contactId: contactEmails.contactId, email: contactEmails.email })
    .from(contactEmails)
    .where(inArray(contactEmails.contactId, ids))
    .orderBy(contactEmails.priority)
    .all();
  const firstEmail = new Map<number, string>();
  for (const e of emails) {
    if (!firstEmail.has(e.contactId)) firstEmail.set(e.contactId, e.email);
  }
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        displayName: r.displayName,
        company: r.company,
        title: r.title,
        email: firstEmail.get(r.id) ?? null,
        archived: r.archivedAt !== null,
      },
    ])
  );
}

export async function readDuplicates(): Promise<{
  queue: DuplicatePair[];
  recentMerges: RecentMerge[];
}> {
  await requireAuth();
  const open = db
    .select()
    .from(duplicateCandidates)
    .where(eq(duplicateCandidates.status, "open"))
    .orderBy(desc(duplicateCandidates.score), duplicateCandidates.id)
    .limit(200)
    .all();
  const byId = summaries(
    [...new Set(open.flatMap((p) => [p.contactAId, p.contactBId]))]
  );
  const queue: DuplicatePair[] = [];
  for (const p of open) {
    const a = byId.get(p.contactAId);
    const b = byId.get(p.contactBId);
    if (!a || !b) continue;
    let reasons: string[] = [];
    try {
      const parsed = JSON.parse(p.reasonsJson) as unknown;
      if (Array.isArray(parsed)) {
        reasons = parsed.filter((r): r is string => typeof r === "string");
      }
    } catch {
      // ignore
    }
    queue.push({ id: p.id, score: p.score, reasons, a, b });
  }

  const logs = db
    .select()
    .from(mergeLog)
    .where(isNull(mergeLog.undoneAt))
    .orderBy(desc(mergeLog.mergedAt))
    .limit(10)
    .all();
  const winners = summaries([...new Set(logs.map((l) => l.winnerContactId))]);
  const recentMerges: RecentMerge[] = logs.map((l) => {
    let loserName = `#${l.loserContactId}`;
    try {
      const snap = JSON.parse(l.loserSnapshotJson) as {
        loser?: { display_name?: string };
      };
      loserName = snap.loser?.display_name ?? loserName;
    } catch {
      // ignore
    }
    return {
      logId: l.id,
      winnerId: l.winnerContactId,
      winnerName:
        winners.get(l.winnerContactId)?.displayName ?? `#${l.winnerContactId}`,
      loserName,
      mergedAt: l.mergedAt,
    };
  });

  return { queue, recentMerges };
}

export async function dismissPairAction(input: {
  pairId: number;
}): Promise<void> {
  await requireAuth();
  db.update(duplicateCandidates)
    .set({ status: "dismissed", resolvedAt: Date.now() })
    .where(
      eq(duplicateCandidates.id, input.pairId)
    )
    .run();
  revalidatePath("/duplicates");
}

export async function scanNowAction(): Promise<{ summary: string }> {
  await requireAuth();
  const stats = runDedupeScan();
  revalidatePath("/duplicates");
  return {
    summary: `${stats.contactsScanned} contacts scanned — ${stats.added} new suggestion${stats.added === 1 ? "" : "s"}, ${stats.refreshed} refreshed, ${stats.removedStale} stale removed.`,
  };
}

// ---------- merge preview + actions ----------

export type MergeSideView = {
  id: number;
  displayName: string;
  archived: boolean;
  fields: Record<MergeField, string | null>;
  emails: string[];
  phones: string[];
  socials: string[];
  tags: string[];
  groups: string[];
  /** field-source key → source name, for provenance display. */
  provenance: Record<string, string>;
  interactionCount: number;
  noteCount: number;
};

export type MergePreview = {
  winner: MergeSideView;
  loser: MergeSideView;
  defaults: MergeDecisions;
  fields: MergeField[];
};

type RawRow = Record<string, unknown>;

function fieldDisplay(row: RawRow, field: MergeField): string | null {
  switch (field) {
    case "location":
      return (row.location as string | null) ?? null;
    case "birthday": {
      const m = row.birthday_month as number | null;
      const d = row.birthday_day as number | null;
      const y = row.birthday_year as number | null;
      if (m === null || d === null) return null;
      return `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}${y ? `-${y}` : ""}`;
    }
    case "cadence": {
      const days = row.cadence_days as number | null;
      return days === null ? null : `every ${days} days`;
    }
    case "firstName":
      return (row.first_name as string | null) ?? null;
    case "lastName":
      return (row.last_name as string | null) ?? null;
    case "descriptionMd":
      return (row.description_md as string | null) ?? null;
    case "photoPath":
      return (row.photo_path as string | null) ?? null;
    default:
      return (row[field] as string | null) ?? null;
  }
}

function sideView(id: number): MergeSideView | null {
  const row = rawDb
    .prepare("SELECT * FROM contacts WHERE id = ?")
    .get(id) as RawRow | undefined;
  if (!row) return null;
  const list = (sql: string): string[] =>
    (rawDb.prepare(sql).all(id) as { v: string }[]).map((r) => r.v);
  const one = (sql: string): number =>
    (rawDb.prepare(sql).get(id) as { n: number }).n;
  const fields = {} as Record<MergeField, string | null>;
  for (const f of MERGE_FIELDS) fields[f] = fieldDisplay(row, f);
  const provenance: Record<string, string> = {};
  for (const p of rawDb
    .prepare("SELECT field, source FROM contact_field_sources WHERE contact_id = ?")
    .all(id) as { field: string; source: string }[]) {
    provenance[p.field] = p.source;
  }
  return {
    id,
    displayName: row.display_name as string,
    archived: row.archived_at !== null,
    fields,
    emails: list(
      "SELECT email AS v FROM contact_emails WHERE contact_id = ? ORDER BY priority, id"
    ),
    phones: list(
      "SELECT phone_raw AS v FROM contact_phones WHERE contact_id = ? ORDER BY priority, id"
    ),
    socials: list(
      "SELECT url AS v FROM contact_socials WHERE contact_id = ? ORDER BY id"
    ),
    tags: list(
      "SELECT t.name AS v FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = ? ORDER BY t.name"
    ),
    groups: list(
      "SELECT g.name AS v FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.contact_id = ? ORDER BY g.name"
    ),
    provenance,
    interactionCount: one(
      "SELECT COUNT(*) AS n FROM interactions WHERE contact_id = ?"
    ),
    noteCount: one("SELECT COUNT(*) AS n FROM notes WHERE contact_id = ?"),
  };
}

export async function readMergePreview(input: {
  winnerId: number;
  loserId: number;
}): Promise<MergePreview | { error: string }> {
  await requireAuth();
  const winner = sideView(input.winnerId);
  const loser = sideView(input.loserId);
  if (!winner || !loser) return { error: "One of the contacts no longer exists." };
  const winnerRow = rawDb
    .prepare("SELECT * FROM contacts WHERE id = ?")
    .get(input.winnerId) as RawRow;
  const loserRow = rawDb
    .prepare("SELECT * FROM contacts WHERE id = ?")
    .get(input.loserId) as RawRow;
  return {
    winner,
    loser,
    defaults: defaultDecisions(winnerRow, loserRow),
    fields: MERGE_FIELDS,
  };
}

const decisionSchema = z.record(
  z.string(),
  z.union([z.literal("winner"), z.literal("loser")])
);

export async function mergeAction(input: {
  winnerId: number;
  loserId: number;
  decisions: Partial<MergeDecisions>;
}): Promise<{ error?: string; logId?: number }> {
  await requireAuth();
  const parsed = decisionSchema.safeParse(input.decisions);
  if (!parsed.success) return { error: "Invalid field decisions." };
  try {
    const { logId } = mergeContacts(rawDb, {
      winnerId: input.winnerId,
      loserId: input.loserId,
      decisions: input.decisions,
    });
    revalidatePath("/duplicates");
    revalidatePath("/contacts");
    revalidatePath("/today");
    return { logId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function undoMergeAction(input: {
  logId: number;
}): Promise<{ error?: string }> {
  await requireAuth();
  // Backstop: undo refusals come back as {ok:false, reason}, but an
  // unexpected DB error must surface as a message too, never a raw 500.
  let result: ReturnType<typeof undoMerge>;
  try {
    result = undoMerge(rawDb, input.logId);
  } catch (err) {
    return {
      error: `Undo failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  revalidatePath("/duplicates");
  revalidatePath("/contacts");
  return result.ok ? {} : { error: result.reason };
}
