import "server-only";

import { createHash } from "node:crypto";

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { agentCalls, contacts, notes, reminders } from "@/db/schema";

// One row per tool call the connector serves (SCHEMA.md `agent_calls`,
// SPEC §14) — the agent's audit trail, and from Phase 15 the source of
// undo. What goes in is the validated arguments and a one-line summary;
// never a token, never a tool's full output.

const ARGS_MAX = 4000;
const ERROR_MAX = 500;
const SUMMARY_MAX = 200;

/**
 * `queued` — a write waiting for the owner's approval (review mode);
 * `rejected` — one the owner turned down. Both keep their arguments, so
 * the activity page can show exactly what was proposed.
 */
export type AgentCallStatus = "success" | "error" | "refused" | "queued" | "rejected";

/**
 * What one write call changed, in enough detail to reverse it and nothing
 * more (SCHEMA.md `agent_calls.writes_json`).
 *
 * A row id alone does not say which row it is: SQLite hands a freed id to
 * the next insert, so the row an agent wrote may be gone and a stranger
 * sitting under its number. Every record therefore carries something only
 * the original row has — its creation time, its key, its name — and undo
 * checks it before touching anything. `sig` is a fingerprint of the
 * content as written: if it no longer matches, the owner has edited the
 * row and it is theirs now.
 */
export type WriteRecord =
  | {
      table: "interactions";
      op: "insert";
      id: number;
      contactId: number;
      /** The row's source_key. */
      key: string | null;
      /** A snooze the contact had, which logging a touch cleared. */
      snoozedBefore?: number | null;
    }
  | { table: "notes"; op: "insert"; id: number; contactId: number | null; createdAt: number; sig: string }
  | { table: "reminders"; op: "insert"; id: number; createdAt: number; sig: string }
  | {
      table: "reminders";
      op: "complete";
      id: number;
      completedAt: number;
      /** The next occurrence completing it materialized, and its fingerprint. */
      nextOccurrenceId: number | null;
      nextSig?: string;
    }
  | { table: "contacts"; op: "insert"; id: number; createdAt: number }
  | {
      table: "contacts";
      op: "update";
      id: number;
      createdAt: number;
      /** Each field the call set: what it replaced, and who had set that. */
      fields: { field: string; before: string | null; beforeSource: string | null; after: string }[];
      /** Normalized addresses and profile URLs the call added. */
      emails: string[];
      socialUrls: string[];
      changeIds: number[];
    }
  | { table: "tags"; op: "insert"; id: number; name: string }
  // `at` is when the memberships were written: undo only takes back rows
  // created then, not a membership the owner removed and added again.
  | { table: "contact_tags"; op: "add" | "remove"; tagId: number; tagName: string; contactIds: number[]; at: number }
  | { table: "group_members"; op: "add" | "remove"; groupId: number; groupName: string; contactIds: number[]; at: number };

function fingerprint(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** A note's content as one short string; null when the note is gone. */
export function noteSignature(noteId: number): { createdAt: number; sig: string } | null {
  const row = db.select().from(notes).where(eq(notes.id, noteId)).get();
  if (!row) return null;
  return { createdAt: row.createdAt, sig: fingerprint([row.bodyMd, row.countsForTouch, row.contactId]) };
}

/**
 * A reminder's content and state as one short string. Firing is not part
 * of it — a reminder that came due is still the reminder that was set —
 * but being snoozed, completed or retitled is: those are the owner's.
 */
export function reminderSignature(reminderId: number): { createdAt: number; sig: string } | null {
  const row = db.select().from(reminders).where(eq(reminders.id, reminderId)).get();
  if (!row) return null;
  return {
    createdAt: row.createdAt,
    sig: fingerprint([row.title, row.body, row.dueAt, row.contactId, row.rrule, row.snoozedUntil, row.completedAt]),
  };
}

/** Reads are kept this long; writes (from Phase 15) are the audit trail and stay. */
export const READ_CALL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
let lastPruneAt = 0;

/**
 * Drop rows that changed nothing once they are past retention. An agent
 * that checks in twice a day writes thousands of "searched contacts" and
 * "already on the timeline" rows a year; nothing is ever undone from
 * those, so old ones are noise. Writes, undos and proposals still waiting
 * are the audit trail and stay. Runs at most once a day, on the back of a
 * call being recorded.
 */
export function pruneOldReadCalls(now: number): number {
  return db
    .delete(agentCalls)
    .where(
      and(
        sql`(${agentCalls.writesJson} IS NULL OR (${agentCalls.writesJson} = '[]' AND ${agentCalls.tool} <> 'undo_agent_action'))`,
        sql`${agentCalls.status} <> 'queued'`,
        lt(agentCalls.createdAt, now - READ_CALL_RETENTION_MS)
      )
    )
    .run().changes;
}

export function recordAgentCall(call: {
  grantId: number | null;
  tool: string;
  args: unknown;
  status: AgentCallStatus;
  summary?: string | null;
  error?: string | null;
  contactId?: number | null;
  durationMs?: number;
  now?: number;
  /** Present (even empty) for a write; absent for a read. */
  writes?: WriteRecord[];
  idempotencyKey?: string | null;
  /**
   * Keep the arguments whole. For a proposal waiting on the owner: it is
   * run from this row when approved, so a shortened copy would be a
   * different proposal. Validated arguments are bounded by their schema.
   */
  wholeArgs?: boolean;
}): number {
  let argsJson: string;
  try {
    argsJson = JSON.stringify(call.args ?? {}) ?? "{}";
  } catch {
    argsJson = '{"_unserializable":true}';
  }
  if (!call.wholeArgs && argsJson.length > ARGS_MAX) {
    argsJson = JSON.stringify({ _truncated: true, preview: argsJson.slice(0, ARGS_MAX - 60) });
  }
  const at = call.now ?? Date.now();
  if (at - lastPruneAt > PRUNE_EVERY_MS) {
    lastPruneAt = at;
    pruneOldReadCalls(at);
  }
  // The row may name a contact the call asked about that does not exist;
  // the FK would refuse it, and a refused audit row is worse than a null.
  let contactId = call.contactId ?? null;
  if (
    contactId !== null &&
    !db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).get()
  ) {
    contactId = null;
  }
  return db
    .insert(agentCalls)
    .values({
      grantId: call.grantId,
      tool: call.tool,
      argsJson,
      status: call.status,
      error: call.error ? call.error.slice(0, ERROR_MAX) : null,
      summary: call.summary ? call.summary.slice(0, SUMMARY_MAX) : null,
      contactId,
      writesJson: call.writes ? JSON.stringify(call.writes) : null,
      idempotencyKey: call.idempotencyKey ?? null,
      durationMs: call.durationMs ?? null,
      createdAt: at,
    })
    .returning({ id: agentCalls.id })
    .get().id;
}

/**
 * The key a write is ledgered under: the caller's key, plus the person it
 * is about. One message can concern two contacts — an email to Ana and
 * Ben is logged once for each under the same message id — so the key
 * alone would wrongly make the second a repeat of the first.
 */
export function ledgerKey(idempotencyKey: string, contactId: number | null): string {
  return contactId === null ? idempotencyKey : `${idempotencyKey}#contact:${contactId}`;
}

/**
 * The earlier call made under this ledger key, if one went through, is
 * waiting, or was turned down by the owner — a rejected proposal stays
 * rejected rather than coming back on the agent's next pass.
 */
export function findCallByKey(
  tool: string,
  key: string
): { id: number; status: string; summary: string | null; undoneAt: number | null } | null {
  return (
    db
      .select({
        id: agentCalls.id,
        status: agentCalls.status,
        summary: agentCalls.summary,
        undoneAt: agentCalls.undoneAt,
      })
      .from(agentCalls)
      .where(
        and(
          eq(agentCalls.tool, tool),
          eq(agentCalls.idempotencyKey, key),
          inArray(agentCalls.status, ["success", "queued", "rejected"])
        )
      )
      .orderBy(desc(agentCalls.id))
      .get() ?? null
  );
}

export function parseWrites(writesJson: string | null): WriteRecord[] {
  if (!writesJson) return [];
  try {
    const parsed: unknown = JSON.parse(writesJson);
    return Array.isArray(parsed) ? (parsed as WriteRecord[]) : [];
  } catch {
    return [];
  }
}

export type AgentActivityRow = {
  id: number;
  tool: string;
  status: string;
  summary: string | null;
  error: string | null;
  contactId: number | null;
  contactName: string | null;
  argsJson: string;
  createdAt: number;
  undoneAt: number | null;
  /** Something was written and it can still be reversed. */
  undoable: boolean;
};

/**
 * What the agent changed, or wants to: writes that went through, undos,
 * writes waiting for approval, and ones the owner rejected — newest
 * first. Reads are left out, and so are write calls that turned out to
 * have nothing to do ("already on the timeline"); neither changed
 * anything.
 */
export function listAgentActivity(limit = 100, offset = 0): { rows: AgentActivityRow[]; total: number; queued: number } {
  const where = sql`(
    (${agentCalls.writesJson} IS NOT NULL AND ${agentCalls.writesJson} <> '[]')
    OR ${agentCalls.status} IN ('queued', 'rejected')
    OR (${agentCalls.tool} = 'undo_agent_action' AND ${agentCalls.status} = 'success')
  )`;
  const rows = db
    .select({
      id: agentCalls.id,
      tool: agentCalls.tool,
      status: agentCalls.status,
      summary: agentCalls.summary,
      error: agentCalls.error,
      contactId: agentCalls.contactId,
      contactName: contacts.displayName,
      argsJson: agentCalls.argsJson,
      writesJson: agentCalls.writesJson,
      createdAt: agentCalls.createdAt,
      undoneAt: agentCalls.undoneAt,
    })
    .from(agentCalls)
    .leftJoin(contacts, eq(contacts.id, agentCalls.contactId))
    .where(where)
    .orderBy(desc(agentCalls.createdAt), desc(agentCalls.id))
    .limit(Math.min(Math.max(limit, 1), 200))
    .offset(Math.max(offset, 0))
    .all();
  const count = (status?: string) =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(agentCalls)
      .where(status ? eq(agentCalls.status, status) : where)
      .get()?.n ?? 0;
  return {
    rows: rows.map(({ writesJson, ...r }) => ({
      ...r,
      undoable:
        r.status === "success" &&
        r.undoneAt === null &&
        r.tool !== "undo_agent_action" &&
        parseWrites(writesJson).length > 0,
    })),
    total: count(),
    queued: count("queued"),
  };
}

export function countQueuedAgentCalls(): number {
  return (
    db.select({ n: sql<number>`count(*)` }).from(agentCalls).where(eq(agentCalls.status, "queued")).get()?.n ?? 0
  );
}

/**
 * Notes on this contact that an agent wrote — notes carry no source
 * column. A note counts only while it is still the row that was written
 * (same id, same creation time), so a later note that inherited a freed
 * id is not marked, and one the owner has since edited still is.
 */
export function agentNoteIds(contactId: number): number[] {
  const rows = db
    .select({ writesJson: agentCalls.writesJson })
    .from(agentCalls)
    .where(
      and(
        eq(agentCalls.contactId, contactId),
        eq(agentCalls.status, "success"),
        sql`${agentCalls.writesJson} IS NOT NULL AND ${agentCalls.writesJson} <> '[]'`
      )
    )
    .all();
  const written = new Map<number, number>();
  for (const r of rows) {
    for (const w of parseWrites(r.writesJson)) {
      if (w.table === "notes" && w.op === "insert") written.set(w.id, w.createdAt);
    }
  }
  if (written.size === 0) return [];
  return db
    .select({ id: notes.id, createdAt: notes.createdAt })
    .from(notes)
    .where(inArray(notes.id, [...written.keys()]))
    .all()
    .filter((n) => written.get(n.id) === n.createdAt)
    .map((n) => n.id);
}

export type AgentCallRow = {
  id: number;
  tool: string;
  status: string;
  summary: string | null;
  error: string | null;
  createdAt: number;
  durationMs: number | null;
};

export function listRecentAgentCalls(limit = 20): AgentCallRow[] {
  return db
    .select({
      id: agentCalls.id,
      tool: agentCalls.tool,
      status: agentCalls.status,
      summary: agentCalls.summary,
      error: agentCalls.error,
      createdAt: agentCalls.createdAt,
      durationMs: agentCalls.durationMs,
    })
    .from(agentCalls)
    .orderBy(desc(agentCalls.createdAt), desc(agentCalls.id))
    .limit(Math.min(Math.max(limit, 1), 100))
    .all();
}
