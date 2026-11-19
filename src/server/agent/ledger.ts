import "server-only";

import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { agentCalls, contacts } from "@/db/schema";

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
 * more (SCHEMA.md `agent_calls.writes_json`). Ids only, never content: the
 * rows themselves are the record of what was written.
 */
export type WriteRecord =
  | { table: "interactions"; op: "insert"; id: number; contactId: number }
  // `stamp` is the row's updated_at as written: if it has moved, the owner
  // edited the row since, and undo leaves it alone.
  | { table: "notes"; op: "insert"; id: number; contactId: number | null; stamp?: number }
  | { table: "reminders"; op: "insert"; id: number; stamp?: number }
  | { table: "reminders"; op: "complete"; id: number; nextOccurrenceId: number | null }
  | { table: "contacts"; op: "insert"; id: number }
  | {
      table: "contacts";
      op: "update";
      id: number;
      /** Each field the call set: what it replaced, and who had set that. */
      fields: { field: string; before: string | null; beforeSource: string | null; after: string }[];
      emailIds: number[];
      socialIds: number[];
      changeIds: number[];
    }
  | { table: "tags"; op: "insert"; id: number }
  | { table: "contact_tags"; op: "add" | "remove"; tagId: number; contactIds: number[] }
  | { table: "group_members"; op: "add" | "remove"; groupId: number; contactIds: number[] };

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
}): number {
  let argsJson: string;
  try {
    argsJson = JSON.stringify(call.args ?? {}) ?? "{}";
  } catch {
    argsJson = '{"_unserializable":true}';
  }
  if (argsJson.length > ARGS_MAX) {
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

/** Note ids an agent wrote for this contact — notes carry no source column. */
export function agentNoteIds(contactId: number): number[] {
  const rows = db
    .select({ writesJson: agentCalls.writesJson })
    .from(agentCalls)
    .where(
      and(
        eq(agentCalls.contactId, contactId),
        eq(agentCalls.status, "success"),
        isNull(agentCalls.undoneAt),
        sql`${agentCalls.writesJson} IS NOT NULL`
      )
    )
    .all();
  const ids = new Set<number>();
  for (const r of rows) {
    for (const w of parseWrites(r.writesJson)) {
      if (w.table === "notes" && w.op === "insert") ids.add(w.id);
    }
  }
  return [...ids];
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
