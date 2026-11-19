import "server-only";

import crypto from "node:crypto";

import { and, asc, desc, eq, gte, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts, interactions, syncRuns, whatsappLinks, whatsappMessages } from "@/db/schema";
import { recomputeContact } from "@/lib/cadence/recompute";
import { getSetting, ownerTimezone, setSetting } from "@/lib/settings";
import {
  isWaId,
  keyExportMessages,
  messageFingerprint,
  purgeEligible,
  summarizeDay,
  toWaId,
  WA_BODY_MAX,
  WA_KINDS,
  WA_PURGE_GRACE_MS,
  WA_RETENTION_MS,
  WA_SAVED_NAME_MAX,
  waDayKey,
  wantsForLink,
  type WaMessage,
  type WaWant,
} from "@/lib/whatsapp/chat";
import { assignDirections, exportTextFromUpload, parseWhatsAppExport } from "@/lib/whatsapp/export";

// WhatsApp, per person (SPEC §15). No session and no page cache here: the
// contact page's actions, the collector's endpoint, the retention job and
// the agent connector all call this module. (Plain module, not "use
// server" — CLAUDE.md.)
//
// The shape of the whole feature is in two rules this file enforces:
//
//   1. Rolo knows a WhatsApp chat only as a row the owner created by
//      typing a number on a contact. Nothing arrives for a number that
//      has no such row, whoever sends it.
//   2. A message's text is cleared only when it is both past retention
//      and inside the saved summary — and then a week later still.

export type WhatsAppLink = typeof whatsappLinks.$inferSelect;
type CoreError = { ok: false; error: string };

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- the link ----------

export function hasWhatsAppLinks(): boolean {
  return db.select({ id: whatsappLinks.id }).from(whatsappLinks).limit(1).get() !== undefined;
}

export function getWhatsAppLink(contactId: number): WhatsAppLink | null {
  return db.select().from(whatsappLinks).where(eq(whatsappLinks.contactId, contactId)).get() ?? null;
}

function cleanSavedName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, WA_SAVED_NAME_MAX);
}

export function linkWhatsApp(
  contactId: number,
  input: { number: string; savedName: string },
  now = Date.now()
): { ok: true; link: WhatsAppLink } | CoreError {
  const who = db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).get();
  if (!who) return { ok: false, error: "Contact not found." };
  const waId = toWaId(input.number, getSetting<string>("phone_default_region") ?? undefined);
  if (!waId) {
    return { ok: false, error: "That is not a phone number Rolo can read. Type it with the country code, like +44 7911 123456." };
  }
  const savedName = cleanSavedName(input.savedName);
  if (!savedName) return { ok: false, error: "Type the name this person is saved under in your WhatsApp." };
  if (getWhatsAppLink(contactId)) return { ok: false, error: "This contact already has a WhatsApp chat linked." };
  const taken = db
    .select({ contactId: whatsappLinks.contactId, name: contacts.displayName })
    .from(whatsappLinks)
    .innerJoin(contacts, eq(contacts.id, whatsappLinks.contactId))
    .where(eq(whatsappLinks.waId, waId))
    .get();
  if (taken) return { ok: false, error: `That number is already linked to ${taken.name}.` };
  const link = db
    .insert(whatsappLinks)
    .values({ contactId, waId, savedName, syncEnabled: false, createdAt: now, updatedAt: now })
    .returning()
    .get();
  return { ok: true, link };
}

export function updateWhatsAppLink(
  contactId: number,
  change: { savedName?: string; syncEnabled?: boolean; syncFrom?: number | null },
  now = Date.now()
): { ok: true; link: WhatsAppLink } | CoreError {
  const link = getWhatsAppLink(contactId);
  if (!link) return { ok: false, error: "No WhatsApp chat is linked to this contact." };
  const set: Partial<typeof whatsappLinks.$inferInsert> = { updatedAt: now };
  if (change.savedName !== undefined) {
    const savedName = cleanSavedName(change.savedName);
    if (!savedName) return { ok: false, error: "The saved name cannot be empty." };
    set.savedName = savedName;
  }
  if (change.syncEnabled !== undefined) set.syncEnabled = change.syncEnabled;
  if (change.syncFrom !== undefined) {
    if (change.syncFrom !== null) {
      if (!Number.isInteger(change.syncFrom) || change.syncFrom <= 0) return { ok: false, error: "That is not a date." };
      if (change.syncFrom > now) return { ok: false, error: "History can only be imported from a date in the past." };
    }
    set.syncFrom = change.syncFrom;
  }
  db.update(whatsappLinks).set(set).where(eq(whatsappLinks.id, link.id)).run();
  // A renamed chat shows the new name in its day rows.
  if (set.savedName && set.savedName !== link.savedName) rebuildAllDays(link.id);
  return { ok: true, link: getWhatsAppLink(contactId)! };
}

/**
 * Remove everything Rolo imported from WhatsApp for this person — the
 * link, every message, the summary, and the timeline rows built from
 * them. Nothing else about the contact is touched, and nothing in
 * WhatsApp itself can be: Rolo has no way to reach it.
 */
export function deleteWhatsAppData(contactId: number): { ok: true; messages: number; timelineRows: number } | CoreError {
  const link = getWhatsAppLink(contactId);
  if (!link) return { ok: false, error: "No WhatsApp chat is linked to this contact." };
  return db.transaction(() => {
    const messages =
      db.select({ n: sql<number>`count(*)` }).from(whatsappMessages).where(eq(whatsappMessages.linkId, link.id)).get()?.n ?? 0;
    const timelineRows = db
      .delete(interactions)
      .where(and(eq(interactions.contactId, contactId), eq(interactions.source, "whatsapp")))
      .run().changes;
    // Messages go with the link (ON DELETE CASCADE).
    db.delete(whatsappLinks).where(eq(whatsappLinks.id, link.id)).run();
    recomputeContact(contactId);
    return { ok: true as const, messages, timelineRows };
  });
}

// ---------- timeline rows, derived ----------

/**
 * Rebuild the one-row-per-day timeline entries for the days these
 * messages fall on. The rows are derived from whatsapp_messages and are
 * never written any other way.
 */
function rebuildDays(link: WhatsAppLink, fromMs: number, toMs: number): void {
  const tz = ownerTimezone();
  // A local day can start up to 14h before and end 12h after its UTC date.
  const rows = db
    .select()
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.linkId, link.id),
        gte(whatsappMessages.sentAt, fromMs - 2 * DAY_MS),
        lte(whatsappMessages.sentAt, toMs + 2 * DAY_MS)
      )
    )
    .orderBy(asc(whatsappMessages.sentAt), asc(whatsappMessages.id))
    .all();
  const firstDay = waDayKey(tz, fromMs);
  const lastDay = waDayKey(tz, toMs);
  const byDay = new Map<string, typeof rows>();
  for (const row of rows) {
    const day = waDayKey(tz, row.sentAt);
    if (day < firstDay || day > lastDay) continue;
    const list = byDay.get(day) ?? [];
    list.push(row);
    byDay.set(day, list);
  }
  const existing = db
    .select({ id: interactions.id, sourceKey: interactions.sourceKey })
    .from(interactions)
    .where(
      and(
        eq(interactions.contactId, link.contactId),
        eq(interactions.source, "whatsapp"),
        gte(interactions.sourceKey, `wa-day:${firstDay}`),
        lte(interactions.sourceKey, `wa-day:${lastDay}`)
      )
    )
    .all();
  const existingByKey = new Map(existing.map((e) => [e.sourceKey, e.id]));
  const now = Date.now();
  for (const [day, messages] of byDay) {
    const row = summarizeDay(
      day,
      messages.map((m) => ({
        direction: m.direction === "outbound" ? "outbound" : "inbound",
        sentAt: m.sentAt,
        kind: (WA_KINDS as readonly string[]).includes(m.kind) ? (m.kind as WaMessage["kind"]) : "other",
        body: m.body,
      })),
      link.savedName
    );
    if (!row) continue;
    const values = {
      kind: "message",
      direction: row.direction,
      occurredAt: row.occurredAt,
      title: row.title,
      meta: JSON.stringify({
        channel: "whatsapp",
        day: row.day,
        count: row.count,
        sent: row.sent,
        received: row.received,
        ...(row.transcript ? { body: row.transcript } : {}),
      }),
      countsForTouch: row.countsForTouch,
    };
    const id = existingByKey.get(row.sourceKey);
    if (id !== undefined) {
      db.update(interactions).set(values).where(eq(interactions.id, id)).run();
      existingByKey.delete(row.sourceKey);
    } else {
      db.insert(interactions)
        .values({ ...values, contactId: link.contactId, source: "whatsapp", sourceKey: row.sourceKey, createdAt: now })
        .run();
    }
  }
  // A day that no longer has any message has no row.
  for (const id of existingByKey.values()) db.delete(interactions).where(eq(interactions.id, id)).run();
  recomputeContact(link.contactId);
}

function rebuildAllDays(linkId: number): void {
  const link = db.select().from(whatsappLinks).where(eq(whatsappLinks.id, linkId)).get();
  if (!link) return;
  const span = db
    .select({ first: sql<number | null>`min(${whatsappMessages.sentAt})`, last: sql<number | null>`max(${whatsappMessages.sentAt})` })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.linkId, linkId))
    .get();
  if (!span || span.first === null || span.last === null) return;
  rebuildDays(link, span.first, span.last);
}

// ---------- taking messages in ----------

export type IngestResult = { added: number; alreadyThere: number; updated: number; firstAt: number | null; lastAt: number | null };

/**
 * Store messages for one linked chat. Idempotent three ways: the same key
 * again is the same message; a message another source already delivered
 * (an export line and the collector's copy of it) is recognised by what
 * it says and when; and text that has been purged is not brought back.
 */
export function ingestWhatsAppMessages(
  link: WhatsAppLink,
  incoming: WaMessage[],
  source: "collector" | "export",
  now = Date.now()
): IngestResult {
  const result: IngestResult = { added: 0, alreadyThere: 0, updated: 0, firstAt: null, lastAt: null };
  if (incoming.length === 0) return result;
  const ordered = [...incoming].sort((a, b) => a.sentAt - b.sentAt);
  const min = ordered[0].sentAt;
  const max = ordered[ordered.length - 1].sentAt;

  db.transaction(() => {
    const nearby = db
      .select()
      .from(whatsappMessages)
      .where(
        and(
          eq(whatsappMessages.linkId, link.id),
          gte(whatsappMessages.sentAt, min - 2000),
          lte(whatsappMessages.sentAt, max + 2000)
        )
      )
      .all();
    const byKey = new Map(nearby.map((r) => [r.messageKey, r]));
    // Keys written by this very call: a delivery that repeats a message
    // within itself stores it once.
    const justAdded = new Set<string>();
    // What the other source already holds, by content — and, for rows
    // whose text is gone, by time and direction alone.
    const elsewhere = new Map<string, number>();
    const elsewherePurged = new Map<string, number>();
    for (const r of nearby) {
      if (r.source === source) continue;
      const shape = { direction: r.direction as WaMessage["direction"], sentAt: r.sentAt, kind: r.kind as WaMessage["kind"], body: r.body };
      if (r.bodyPurgedAt !== null) {
        const print = messageFingerprint(shape, { ignoreBody: true });
        elsewherePurged.set(print, (elsewherePurged.get(print) ?? 0) + 1);
      } else {
        const print = messageFingerprint(shape);
        elsewhere.set(print, (elsewhere.get(print) ?? 0) + 1);
      }
    }
    const take = (map: Map<string, number>, print: string): boolean => {
      const left = map.get(print) ?? 0;
      if (left <= 0) return false;
      map.set(print, left - 1);
      return true;
    };

    let touchedFrom = Infinity;
    let touchedTo = -Infinity;
    const touch = (at: number) => {
      touchedFrom = Math.min(touchedFrom, at);
      touchedTo = Math.max(touchedTo, at);
    };
    for (const m of ordered) {
      const body = m.kind === "text" && m.body ? m.body.slice(0, WA_BODY_MAX) : null;
      if (justAdded.has(m.key)) {
        result.alreadyThere += 1;
        continue;
      }
      const have = byKey.get(m.key);
      if (have) {
        // An edit made in WhatsApp reaches Rolo; purged text stays purged.
        if (have.bodyPurgedAt === null && (have.body !== body || have.kind !== m.kind) && source === "collector") {
          db.update(whatsappMessages).set({ body, kind: m.kind }).where(eq(whatsappMessages.id, have.id)).run();
          have.body = body;
          have.kind = m.kind;
          result.updated += 1;
          touch(have.sentAt);
        } else {
          result.alreadyThere += 1;
        }
        continue;
      }
      const shape = { direction: m.direction, sentAt: m.sentAt, kind: m.kind, body };
      if (take(elsewhere, messageFingerprint(shape)) || take(elsewherePurged, messageFingerprint(shape, { ignoreBody: true }))) {
        result.alreadyThere += 1;
        continue;
      }
      db.insert(whatsappMessages)
        .values({ linkId: link.id, messageKey: m.key, direction: m.direction, sentAt: m.sentAt, kind: m.kind, body, source, createdAt: now })
        .run();
      justAdded.add(m.key);
      result.added += 1;
      touch(m.sentAt);
      result.firstAt = result.firstAt === null ? m.sentAt : Math.min(result.firstAt, m.sentAt);
      result.lastAt = result.lastAt === null ? m.sentAt : Math.max(result.lastAt, m.sentAt);
    }
    if (touchedFrom !== Infinity) rebuildDays(link, touchedFrom, touchedTo);
  });
  return result;
}

// ---------- the phone export ----------

export type ExportImportResult =
  | {
      ok: true;
      added: number;
      alreadyThere: number;
      total: number;
      firstAt: number;
      lastAt: number;
      timezone: string;
      dateOrder: string;
      dateOrderAssumed: boolean;
      skipped: number;
    }
  | { ok: false; error: string; senders?: string[] };

/**
 * Import a phone's "Export chat" file onto the contact it was uploaded
 * for. Uploading it there is what says whose chat it is; the name inside
 * the file only says which of its two voices is theirs.
 */
export function importWhatsAppExport(
  contactId: number,
  bytes: Uint8Array,
  fileName: string,
  opts: { theirName?: string } = {},
  now = Date.now()
): ExportImportResult {
  const link = getWhatsAppLink(contactId);
  if (!link) return { ok: false, error: "Link this contact's WhatsApp chat first." };
  const text = exportTextFromUpload(bytes, fileName);
  if (!text.ok) return text;
  const tz = ownerTimezone();
  const parsed = parseWhatsAppExport(text.text, tz);
  if (!parsed.ok) return parsed;
  const assigned = assignDirections(parsed, opts.theirName?.trim() || link.savedName);
  if (!assigned.ok) {
    return assigned.reason === "group"
      ? {
          ok: false,
          error: `This export has ${assigned.senders.length} people in it. Group chats are not imported — only a one-to-one conversation.`,
        }
      : {
          ok: false,
          error: `Nobody in this file is called "${opts.theirName?.trim() || link.savedName}". Choose which name is theirs.`,
          senders: assigned.senders,
        };
  }
  const future = assigned.messages.filter((m) => m.sentAt > now + DAY_MS).length;
  if (future > 0) {
    return { ok: false, error: `${future} messages are dated in the future, so the dates were not read correctly. Nothing was imported.` };
  }
  const runId = db
    .insert(syncRuns)
    .values({ kind: "whatsapp_export", status: "running", startedAt: now, fileName: fileName.slice(0, 200) })
    .returning({ id: syncRuns.id })
    .get().id;
  try {
    const res = ingestWhatsAppMessages(link, keyExportMessages(link.waId, assigned.messages), "export", now);
    db.update(syncRuns)
      .set({ status: "success", finishedAt: Date.now(), statsJson: JSON.stringify({ contactId, added: res.added, alreadyThere: res.alreadyThere }) })
      .where(eq(syncRuns.id, runId))
      .run();
    return {
      ok: true,
      added: res.added,
      alreadyThere: res.alreadyThere,
      total: assigned.messages.length,
      firstAt: parsed.firstAt,
      lastAt: parsed.lastAt,
      timezone: tz,
      dateOrder: parsed.dateOrder,
      dateOrderAssumed: parsed.dateOrderAssumed,
      skipped: parsed.skipped,
    };
  } catch (err) {
    db.update(syncRuns)
      .set({ status: "failed", finishedAt: Date.now(), error: err instanceof Error ? err.message.slice(0, 500) : "failed" })
      .where(eq(syncRuns.id, runId))
      .run();
    throw err;
  }
}

// ---------- the laptop collector ----------

const TOKEN_KEY = "whatsapp_collector.token";
const SEEN_KEY = "whatsapp_collector.last_seen_at";

export function getCollectorToken(): string | null {
  return getSetting<string>(TOKEN_KEY) ?? null;
}

export function rotateCollectorToken(): string {
  const token = crypto.randomBytes(24).toString("base64url");
  setSetting(TOKEN_KEY, token);
  return token;
}

/** Constant-time; with no token set, nothing matches and the endpoint is shut. */
export function collectorTokenMatches(presented: string | null): boolean {
  const expected = getCollectorToken();
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function collectorLastSeenAt(): number | null {
  return getSetting<number>(SEEN_KEY) ?? null;
}

/**
 * Everything the collector is asked to read: the numbers whose sync is on,
 * each with the date ranges still wanted. No names, no contact ids, and
 * nothing about anyone whose sync is off.
 */
export function collectorWants(now = Date.now()): WaWant[] {
  setSetting(SEEN_KEY, now);
  const links = db.select().from(whatsappLinks).where(eq(whatsappLinks.syncEnabled, true)).all();
  const wants: WaWant[] = [];
  for (const link of links) {
    const newest = db
      .select({ at: sql<number | null>`max(${whatsappMessages.sentAt})` })
      .from(whatsappMessages)
      .where(and(eq(whatsappMessages.linkId, link.id), eq(whatsappMessages.source, "collector")))
      .get()?.at;
    wants.push(...wantsForLink({ ...link, newestCollectorAt: newest ?? null }));
  }
  return wants;
}

export type CollectorChat = {
  waId: string;
  /** The stretch of time the collector actually read for this chat. */
  coveredFrom: number;
  coveredTo: number;
  messages: WaMessage[];
};

export type CollectorDelivery = {
  accepted: number;
  alreadyThere: number;
  updated: number;
  /** Chats that are not linked with sync on. Their messages were discarded unread. */
  refusedChats: number;
};

/**
 * Take a delivery from the collector. The collector filters before it
 * sends; this is the same filter again, on the server, so that a bug or a
 * stale list on the laptop cannot put an unlinked chat into Rolo.
 */
export function collectorDeliver(chats: CollectorChat[], now = Date.now()): CollectorDelivery {
  setSetting(SEEN_KEY, now);
  const out: CollectorDelivery = { accepted: 0, alreadyThere: 0, updated: 0, refusedChats: 0 };
  for (const chat of chats) {
    const link = isWaId(chat.waId)
      ? db
          .select()
          .from(whatsappLinks)
          .where(and(eq(whatsappLinks.waId, chat.waId), eq(whatsappLinks.syncEnabled, true)))
          .get()
      : undefined;
    if (!link) {
      out.refusedChats += 1;
      continue;
    }
    const from = link.syncFrom ?? link.createdAt;
    // Nothing from before the date the owner asked for, whatever was sent.
    const wanted = chat.messages.filter((m) => m.sentAt >= from && m.sentAt <= now + DAY_MS);
    const res = ingestWhatsAppMessages(link, wanted, "collector", now);
    out.accepted += res.added;
    out.alreadyThere += res.alreadyThere;
    out.updated += res.updated;
    const coveredFrom = Math.max(from, chat.coveredFrom);
    db.update(whatsappLinks)
      .set({
        lastSyncedAt: now,
        collectorCoveredFrom:
          link.collectorCoveredFrom === null ? coveredFrom : Math.min(link.collectorCoveredFrom, coveredFrom),
        updatedAt: now,
      })
      .where(eq(whatsappLinks.id, link.id))
      .run();
  }
  if (out.accepted > 0 || out.refusedChats > 0) {
    db.insert(syncRuns)
      .values({
        kind: "whatsapp_sync",
        status: out.refusedChats > 0 ? "failed" : "success",
        startedAt: now,
        finishedAt: now,
        statsJson: JSON.stringify(out),
        error:
          out.refusedChats > 0
            ? `The collector sent ${out.refusedChats} chat(s) that are not linked with sync on. They were discarded unread.`
            : null,
      })
      .run();
  }
  return out;
}

// ---------- the rolling summary ----------

export const WA_SUMMARY_MAX = 20_000;
export const WA_SUMMARY_MIN = 80;

export type SummarySaved = { ok: true; linkId: number; contactId: number; updatedAt: number; coversThrough: number } | CoreError;

/**
 * Replace the rolling summary. `coversThrough` is the caller's promise
 * that every message up to that moment is reflected in the text — which
 * is what later allows that text to be cleared — so it can only move
 * forward, and never past the newest message Rolo actually holds.
 */
export function saveWhatsAppSummary(contactId: number, summaryMd: string, coversThrough: number, now = Date.now()): SummarySaved {
  const link = getWhatsAppLink(contactId);
  if (!link) return { ok: false, error: "No WhatsApp chat is linked to this contact." };
  const text = summaryMd.trim();
  if (text.length < WA_SUMMARY_MIN) return { ok: false, error: `A summary shorter than ${WA_SUMMARY_MIN} characters cannot stand in for a conversation.` };
  if (text.length > WA_SUMMARY_MAX) return { ok: false, error: `The summary is longer than ${WA_SUMMARY_MAX} characters.` };
  const newest = db
    .select({ at: sql<number | null>`max(${whatsappMessages.sentAt})` })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.linkId, link.id))
    .get()?.at;
  if (newest === null || newest === undefined) return { ok: false, error: "There are no WhatsApp messages for this contact to summarise." };
  if (!Number.isInteger(coversThrough) || coversThrough > newest) {
    return { ok: false, error: "coversThrough is later than the newest message Rolo holds. A summary can only cover messages that exist." };
  }
  if (link.summaryCoversThrough !== null && coversThrough < link.summaryCoversThrough) {
    return {
      ok: false,
      error: "This summary covers less than the one it would replace. A rolling summary only moves forward: fold the new messages into the existing text.",
    };
  }
  // Strictly later than any marker this chat has had: the marker is how
  // an undo knows it is undoing the latest update and no other, so two
  // updates must never share one — not even in the same millisecond.
  const updatedAt = Math.max(now, (link.summaryUpdatedAt ?? 0) + 1);
  db.update(whatsappLinks)
    .set({
      summaryMd: text,
      summaryCoversThrough: coversThrough,
      summaryUpdatedAt: updatedAt,
      summaryPrevMd: link.summaryMd,
      summaryPrevCoversThrough: link.summaryCoversThrough,
      updatedAt: now,
    })
    .where(eq(whatsappLinks.id, link.id))
    .run();
  return { ok: true, linkId: link.id, contactId, updatedAt, coversThrough };
}

/**
 * Put back the summary that the update at `updatedAt` replaced. Only the
 * latest update can be undone, and only once: Rolo keeps one earlier
 * version, so after an undo there is nothing further back to return to.
 */
export function undoWhatsAppSummary(linkId: number, updatedAt: number, now = Date.now()): { ok: true } | CoreError {
  const link = db.select().from(whatsappLinks).where(eq(whatsappLinks.id, linkId)).get();
  if (!link) return { ok: false, error: "the WhatsApp chat is no longer linked" };
  if (link.summaryUpdatedAt !== updatedAt) return { ok: false, error: "the WhatsApp summary has been updated since, so it was left as it is" };
  db.transaction(() => {
    db.update(whatsappLinks)
      .set({
        summaryMd: link.summaryPrevMd,
        summaryCoversThrough: link.summaryPrevCoversThrough,
        // A new marker, later than every update so far, so that no earlier
        // update can be "undone" into a version that no longer exists.
        summaryUpdatedAt: Math.max(now, updatedAt + 1),
        summaryPrevMd: null,
        summaryPrevCoversThrough: null,
        updatedAt: now,
      })
      .where(eq(whatsappLinks.id, linkId))
      .run();
    // Text that was waiting to be cleared on the strength of the undone
    // summary is no longer covered: take it off the list at once.
    db.update(whatsappMessages)
      .set({ purgeAfter: null })
      .where(
        and(
          eq(whatsappMessages.linkId, linkId),
          isNotNull(whatsappMessages.purgeAfter),
          isNull(whatsappMessages.bodyPurgedAt),
          link.summaryPrevCoversThrough === null ? sql`1 = 1` : sql`${whatsappMessages.sentAt} > ${link.summaryPrevCoversThrough}`
        )
      )
      .run();
  });
  return { ok: true };
}

// ---------- retention ----------

export type RetentionStats = { scheduled: number; unscheduled: number; cleared: number };

/**
 * The nightly pass (SPEC §15). Three steps per chat, in this order:
 * take text off the clearing list if it is no longer covered; put text on
 * the list once it is both older than 90 days and inside the summary;
 * clear text whose week on the list has passed and which is still
 * covered. Text with no summary behind it is never touched.
 */
export function runWhatsAppRetention(now = Date.now()): RetentionStats {
  const stats: RetentionStats = { scheduled: 0, unscheduled: 0, cleared: 0 };
  for (const link of db.select().from(whatsappLinks).all()) {
    const covers = link.summaryCoversThrough;
    const cutoff = now - WA_RETENTION_MS;
    const eligible =
      covers === null
        ? sql`0 = 1`
        : and(lte(whatsappMessages.sentAt, covers), lt(whatsappMessages.sentAt, cutoff));
    stats.unscheduled += db
      .update(whatsappMessages)
      .set({ purgeAfter: null })
      .where(
        and(
          eq(whatsappMessages.linkId, link.id),
          isNotNull(whatsappMessages.purgeAfter),
          isNull(whatsappMessages.bodyPurgedAt),
          covers === null ? sql`1 = 1` : or(sql`${whatsappMessages.sentAt} > ${covers}`, gte(whatsappMessages.sentAt, cutoff))
        )
      )
      .run().changes;
    stats.scheduled += db
      .update(whatsappMessages)
      .set({ purgeAfter: now + WA_PURGE_GRACE_MS })
      .where(and(eq(whatsappMessages.linkId, link.id), isNotNull(whatsappMessages.body), isNull(whatsappMessages.purgeAfter), eligible))
      .run().changes;
    const due = db
      .select({ id: whatsappMessages.id, sentAt: whatsappMessages.sentAt })
      .from(whatsappMessages)
      .where(
        and(
          eq(whatsappMessages.linkId, link.id),
          isNotNull(whatsappMessages.body),
          isNotNull(whatsappMessages.purgeAfter),
          lte(whatsappMessages.purgeAfter, now),
          eligible
        )
      )
      .all()
      // The rule once more, in one place, on each row about to lose its text.
      .filter((m) => purgeEligible(m.sentAt, covers, now));
    if (due.length === 0) continue;
    db.transaction(() => {
      for (const m of due) {
        db.update(whatsappMessages).set({ body: null, bodyPurgedAt: now }).where(eq(whatsappMessages.id, m.id)).run();
      }
      rebuildDays(link, Math.min(...due.map((m) => m.sentAt)), Math.max(...due.map((m) => m.sentAt)));
    });
    stats.cleared += due.length;
  }
  return stats;
}

// ---------- reading ----------

export type WhatsAppOverview = {
  link: WhatsAppLink;
  messages: number;
  withText: number;
  firstAt: number | null;
  lastAt: number | null;
  /** Retained text not yet inside the summary: how many, and from when. */
  unsummarised: number;
  unsummarisedFrom: number | null;
  /** Text waiting out its week before being cleared. */
  scheduledForClearing: number;
};

export function whatsAppOverview(link: WhatsAppLink): WhatsAppOverview {
  const totals = db
    .select({
      messages: sql<number>`count(*)`,
      withText: sql<number>`sum(case when ${whatsappMessages.body} is not null then 1 else 0 end)`,
      firstAt: sql<number | null>`min(${whatsappMessages.sentAt})`,
      lastAt: sql<number | null>`max(${whatsappMessages.sentAt})`,
      scheduled: sql<number>`sum(case when ${whatsappMessages.purgeAfter} is not null and ${whatsappMessages.body} is not null then 1 else 0 end)`,
    })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.linkId, link.id))
    .get();
  const open = db
    .select({ n: sql<number>`count(*)`, from: sql<number | null>`min(${whatsappMessages.sentAt})` })
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.linkId, link.id),
        isNotNull(whatsappMessages.body),
        link.summaryCoversThrough === null ? sql`1 = 1` : sql`${whatsappMessages.sentAt} > ${link.summaryCoversThrough}`
      )
    )
    .get();
  return {
    link,
    messages: totals?.messages ?? 0,
    withText: totals?.withText ?? 0,
    firstAt: totals?.firstAt ?? null,
    lastAt: totals?.lastAt ?? null,
    unsummarised: open?.n ?? 0,
    unsummarisedFrom: open?.from ?? null,
    scheduledForClearing: totals?.scheduled ?? 0,
  };
}

/** Retained text that is not yet in the summary and is at least this old. */
export function unsummarisedBefore(link: WhatsAppLink, cutoff: number): { count: number; from: number | null; to: number | null } {
  const row = db
    .select({
      n: sql<number>`count(*)`,
      from: sql<number | null>`min(${whatsappMessages.sentAt})`,
      to: sql<number | null>`max(${whatsappMessages.sentAt})`,
    })
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.linkId, link.id),
        isNotNull(whatsappMessages.body),
        lte(whatsappMessages.sentAt, cutoff),
        link.summaryCoversThrough === null ? sql`1 = 1` : sql`${whatsappMessages.sentAt} > ${link.summaryCoversThrough}`
      )
    )
    .get();
  return { count: row?.n ?? 0, from: row?.from ?? null, to: row?.to ?? null };
}

export function listWhatsAppLinks(): (WhatsAppOverview & { contactName: string })[] {
  return db
    .select({ link: whatsappLinks, contactName: contacts.displayName })
    .from(whatsappLinks)
    .innerJoin(contacts, eq(contacts.id, whatsappLinks.contactId))
    .orderBy(asc(contacts.displayName))
    .all()
    .map((r) => ({ ...whatsAppOverview(r.link), contactName: r.contactName }));
}

export function readWhatsAppMessages(
  linkId: number,
  opts: { since?: number | null; until?: number | null; limit: number; offset: number; newestFirst: boolean }
): { total: number; rows: { sentAt: number; direction: string; kind: string; body: string | null; purged: boolean }[] } {
  const where = and(
    eq(whatsappMessages.linkId, linkId),
    opts.since ? gte(whatsappMessages.sentAt, opts.since) : undefined,
    opts.until ? lte(whatsappMessages.sentAt, opts.until) : undefined
  );
  const total = db.select({ n: sql<number>`count(*)` }).from(whatsappMessages).where(where).get()?.n ?? 0;
  const rows = db
    .select({
      sentAt: whatsappMessages.sentAt,
      direction: whatsappMessages.direction,
      kind: whatsappMessages.kind,
      body: whatsappMessages.body,
      purgedAt: whatsappMessages.bodyPurgedAt,
    })
    .from(whatsappMessages)
    .where(where)
    .orderBy(
      opts.newestFirst ? desc(whatsappMessages.sentAt) : asc(whatsappMessages.sentAt),
      opts.newestFirst ? desc(whatsappMessages.id) : asc(whatsappMessages.id)
    )
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
  return { total, rows: rows.map(({ purgedAt, ...r }) => ({ ...r, purged: purgedAt !== null })) };
}

/** A contact by the name the owner saved them under in WhatsApp ("John"). */
export function contactIdsBySavedName(name: string): number[] {
  const wanted = name.replace(/\s+/g, " ").trim().toLowerCase();
  if (!wanted) return [];
  return db
    .select({ contactId: whatsappLinks.contactId })
    .from(whatsappLinks)
    .where(sql`lower(${whatsappLinks.savedName}) = ${wanted}`)
    .all()
    .map((r) => r.contactId);
}

