import "server-only";

import { and, desc, eq, isNull, lt } from "drizzle-orm";

import { db } from "@/db/client";
import { agentCalls, contacts } from "@/db/schema";

// One row per tool call the connector serves (SCHEMA.md `agent_calls`,
// SPEC §14) — the agent's audit trail, and from Phase 15 the source of
// undo. What goes in is the validated arguments and a one-line summary;
// never a token, never a tool's full output.

const ARGS_MAX = 4000;
const ERROR_MAX = 500;
const SUMMARY_MAX = 200;

export type AgentCallStatus = "success" | "error" | "refused";

/** Reads are kept this long; writes (from Phase 15) are the audit trail and stay. */
export const READ_CALL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
let lastPruneAt = 0;

/**
 * Drop read-only rows past retention. An agent that checks in twice a day
 * writes thousands of "searched contacts" rows a year; nothing is ever
 * undone from a read, so old ones are noise. Runs at most once a day, on
 * the back of a call being recorded.
 */
export function pruneOldReadCalls(now: number): number {
  return db
    .delete(agentCalls)
    .where(and(isNull(agentCalls.writesJson), lt(agentCalls.createdAt, now - READ_CALL_RETENTION_MS)))
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
      durationMs: call.durationMs ?? null,
      createdAt: at,
    })
    .returning({ id: agentCalls.id })
    .get().id;
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
