import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { contactEmails, integrationAccounts, interactions, syncRuns } from "@/db/schema";
import { recomputeContact } from "@/lib/cadence/recompute";
import { normalizeEmail } from "@/lib/contacts/normalize";
import { outboundFetch } from "@/lib/net/fetch";
import { getSetting, setSetting } from "@/lib/settings";
import {
  buildHistoryListUrl,
  buildMessageListUrl,
  buildMessageMetadataUrl,
  buildProfileUrl,
  isGmailRateLimit,
  RATE_LIMIT_RETRY_MS,
  RATE_LIMIT_RUN_BUDGET_MS,
  extractAddressNames,
  parseHistoryPage,
  parseMessageMeta,
  resolveDirection,
  type GmailMessageMeta,
} from "@/lib/sync/gmail";
import type { SightingInput } from "@/lib/suggestions/rank";
import { recordSightings } from "@/server/sync/suggestions";
import {
  accessTokenFor,
  getAccount,
  markAccountError,
  myAddressList,
} from "@/server/sync/accounts";

// Gmail metadata sync engine (SPEC §9). Backfill walks messages.list
// newest-first until it passes the window (the metadata scope forbids the
// `q` parameter, so the cutoff is client-side on internalDate), then
// incremental sync rides historyId. All fetches go through the pure
// builders in lib/sync/gmail — nothing here can request a body.

const BACKFILL_PAGES_PER_RUN = 2; // 2 × 500 ids per tick, until caught up
// 4, not 8: halves the burst against Google's per-user quota (units per
// minute), which the first backfill of a busy mailbox tripped at 8.
const METADATA_CONCURRENCY = 4;
const BACKFILL_STATE_KEY = "sync.gmail.backfill";
// historyId-expiry recovery: how many list pages the bounded re-list may
// walk (20 × 500 ids), and how much slack before the last known sync point
// the cutoff sits to absorb clock skew and in-flight mail.
const RESYNC_MAX_PAGES = 20;
const RESYNC_SLACK_MS = 6 * 3600 * 1000;

type BackfillState = {
  pageToken: string | null;
  /** historyId captured when the backfill started — the incremental baseline. */
  baselineHistoryId: string;
  cutoffMs: number;
};

export type GmailSyncStats = {
  messagesSeen: number;
  /** Mass mail set aside (isBulkMail): newsletters, receipts, list mail. */
  bulkSkipped: number;
  interactionsAdded: number;
  contactsTouched: number;
  backfillDone: boolean;
  /** Set when Google's per-minute quota cut the run short: the cursor is
   * saved, and the scheduler should come back sooner than the interval. */
  resumeSoon?: boolean;
  /** Message ids listed but not yet fetched when the budget ran out. */
  pendingIds?: number;
  /** Ids the bounded pending queue could not hold (fail loud, never silent). */
  pendingDropped?: number;
  /** Top unmatched counterpart addresses (suggestion fodder, SPEC §9). */
  unmatchedTop: { email: string; count: number }[];
};

class GmailApiError extends Error {
  constructor(
    public status: number,
    body: string
  ) {
    super(`Gmail API ${status}: ${body.slice(0, 300)}`);
  }
}

/** The quota reply (isGmailRateLimit): retried with a pause, then the run
 * ends "partial" with its state saved and resumes on the next tick. */
class GmailRateLimited extends GmailApiError {}

/** How much waiting this run has left; shared by every batch in it. */
type RateBudget = { remainingMs: number };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function gmailJson(url: string, token: string): Promise<unknown> {
  const res = await outboundFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw isGmailRateLimit(res.status, body)
      ? new GmailRateLimited(res.status, body)
      : new GmailApiError(res.status, body);
  }
  return res.json();
}

async function fetchChunk(
  chunk: string[],
  token: string
): Promise<(GmailMessageMeta | null)[]> {
  return Promise.all(
    chunk.map(async (id) => {
      try {
        return parseMessageMeta(
          await gmailJson(buildMessageMetadataUrl(id), token)
        );
      } catch (err) {
        // A single message 404 (deleted between list and get) must not
        // fail the run.
        if (err instanceof GmailApiError && err.status === 404) return null;
        throw err;
      }
    })
  );
}

type MetaFetch = { metas: GmailMessageMeta[]; remaining: string[] };

/**
 * Fetch metadata for `ids`, pausing on Google's per-minute quota while the
 * run has waiting budget. When the budget is spent it does NOT throw: it
 * hands back what was fetched and what wasn't, so the caller commits the
 * former and queues the latter (pushPending) — throwing here discarded a
 * whole page of paid-for fetches and, in the incremental step, left the
 * historyId where it was, so a backlog bigger than one run's budget was
 * re-listed and re-fetched from the same point every two minutes, forever.
 */
async function fetchMetas(
  ids: string[],
  token: string,
  budget: RateBudget
): Promise<MetaFetch> {
  const out: GmailMessageMeta[] = [];
  for (let i = 0; i < ids.length; i += METADATA_CONCURRENCY) {
    const chunk = ids.slice(i, i + METADATA_CONCURRENCY);
    let metas: (GmailMessageMeta | null)[] | null = null;
    for (let attempt = 0; metas === null; attempt++) {
      try {
        metas = await fetchChunk(chunk, token);
      } catch (err) {
        if (!(err instanceof GmailRateLimited)) throw err;
        const wait = RATE_LIMIT_RETRY_MS[attempt];
        if (wait === undefined || wait > budget.remainingMs) {
          return { metas: out, remaining: ids.slice(i) };
        }
        budget.remainingMs -= wait;
        await sleep(wait);
      }
    }
    for (const m of metas) if (m) out.push(m);
  }
  return { metas: out, remaining: [] };
}

// ---------- pending ids: listed, not yet fetched ----------

const PENDING_IDS_KEY = "sync.gmail.pending_ids";
const PENDING_IDS_MAX = 20_000;
type PendingIds = { ids: string[]; cutoffMs: number | null };

function getPending(): PendingIds | null {
  const p = getSetting<PendingIds>(PENDING_IDS_KEY);
  return p && Array.isArray(p.ids) && p.ids.length > 0 ? p : null;
}

/** Queue ids the budget didn't reach, so the list cursor can advance
 * anyway. `cutoffMs` keeps the backfill window honest for ids that came
 * from a backfill page; null (incremental) means no cutoff, and a mix
 * takes the looser rule — a few extra old emails beat a missed new one.
 * Bounded; overflow is counted on the run, never dropped silently. */
function pushPending(ids: string[], cutoffMs: number | null, stats: GmailSyncStats): void {
  const existing = getPending();
  const merged = [...new Set([...(existing?.ids ?? []), ...ids])];
  if (merged.length > PENDING_IDS_MAX) {
    stats.pendingDropped = (stats.pendingDropped ?? 0) + (merged.length - PENDING_IDS_MAX);
    merged.length = PENDING_IDS_MAX;
  }
  const cutoff =
    existing && existing.ids.length > 0
      ? existing.cutoffMs === null || cutoffMs === null
        ? null
        : Math.min(existing.cutoffMs, cutoffMs)
      : cutoffMs;
  setSetting(PENDING_IDS_KEY, { ids: merged, cutoffMs: cutoff });
  stats.pendingIds = merged.length;
}

/** Fetch and process queued ids first. Returns true when the queue is
 * empty afterwards (the run may go on to its cursor step). */
async function drainPending(
  token: string,
  myAddresses: string[],
  stats: GmailSyncStats,
  unmatched: Map<string, number>,
  touched: Set<number>,
  sightings: SightingInput[],
  budget: RateBudget
): Promise<boolean> {
  const pending = getPending();
  if (!pending) return true;
  const { metas, remaining } = await fetchMetas(pending.ids, token, budget);
  const usable =
    pending.cutoffMs === null
      ? metas
      : metas.filter((m) => m.internalDate >= (pending.cutoffMs as number));
  processMessages(usable, myAddresses, stats, unmatched, touched, sightings);
  setSetting(PENDING_IDS_KEY, remaining.length > 0 ? { ids: remaining, cutoffMs: pending.cutoffMs } : null);
  stats.pendingIds = remaining.length;
  return remaining.length === 0;
}

function contactIdsByEmail(addresses: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const address of addresses) {
    const hit = db
      .select({ contactId: contactEmails.contactId })
      .from(contactEmails)
      .where(eq(contactEmails.emailNormalized, normalizeEmail(address)))
      .get();
    if (hit) map.set(address, hit.contactId);
  }
  return map;
}

function processMessages(
  metas: GmailMessageMeta[],
  myAddresses: string[],
  stats: GmailSyncStats,
  unmatched: Map<string, number>,
  touched: Set<number>,
  sightings: SightingInput[]
): void {
  for (const meta of metas) {
    stats.messagesSeen++;
    // A newsletter, a receipt, a list post: not a conversation, so neither
    // a touch on a contact's timeline nor a sighting for "People you met".
    if (meta.bulk) {
      stats.bulkSkipped++;
      continue;
    }
    const { direction, counterparts } = resolveDirection(meta, myAddresses);
    if (counterparts.length === 0) continue;
    const matches = contactIdsByEmail(counterparts);
    // Display names for the "People you met" queue (SPEC §9f) — read
    // from the same headers, never stored beyond the name itself.
    const names = new Map<string, string | null>();
    for (const a of extractAddressNames([meta.from, ...meta.to, ...meta.cc].filter(Boolean).join(", "))) {
      if (!names.get(a.email)) names.set(a.email, a.name);
    }
    for (const address of counterparts) {
      const contactId = matches.get(address);
      if (contactId === undefined) {
        unmatched.set(address, (unmatched.get(address) ?? 0) + 1);
        sightings.push({
          email: address,
          name: names.get(address) ?? null,
          kind: "email",
          key: meta.id,
          occurredAt: meta.internalDate,
          title: meta.subject,
          direction,
        });
        continue;
      }
      const inserted = db
        .insert(interactions)
        .values({
          contactId,
          kind: "email",
          direction,
          occurredAt: meta.internalDate,
          title: meta.subject,
          meta: JSON.stringify({ threadId: meta.threadId }),
          source: "gmail",
          sourceKey: meta.id,
          // Only outbound email counts for touch (SPEC §3: someone
          // emailing you is not you keeping in touch).
          countsForTouch: direction === "outbound",
          createdAt: Date.now(),
        })
        // A rescan after "my addresses" changed must be able to flip a
        // stored row's direction (an alias that is now you turns "they
        // emailed me" into "I emailed them"); onConflictDoNothing made
        // that rescan a no-op for every message already stored.
        .onConflictDoUpdate({
          target: [interactions.contactId, interactions.source, interactions.sourceKey],
          targetWhere: sql`source_key IS NOT NULL`,
          set: { direction, countsForTouch: direction === "outbound" },
          setWhere: sql`${interactions.direction} IS NOT excluded.direction`,
        })
        .run();
      if (inserted.changes > 0) {
        stats.interactionsAdded++;
        touched.add(contactId);
      }
    }
  }
}

/**
 * Start the backfill over from the newest message. Idempotent on data —
 * interactions are keyed by Gmail message id — so the cost is only the
 * paced re-read. Called when "my addresses" change (every message's
 * direction and counterparts depend on that list) and on disconnect, so
 * a reconnect never resumes a stale cursor from a previous account.
 */
export function resetGmailBackfill(): void {
  setSetting(BACKFILL_STATE_KEY, null);
  setSetting(PENDING_IDS_KEY, null);
  const account = getAccount("google");
  if (!account) return;
  // A contact that carries one of the owner's own addresses is the owner;
  // gmail rows filed under it are self-interactions from before that
  // address was on the list. The rescan cannot repair those (it never
  // sees "me" as a counterpart), so they go now and the cadence is
  // recomputed without them.
  const mine = myAddressList(account).map((a) => normalizeEmail(a));
  if (mine.length > 0) {
    const selfIds = db
      .select({ contactId: contactEmails.contactId })
      .from(contactEmails)
      .where(inArray(contactEmails.emailNormalized, mine))
      .all()
      .map((r) => r.contactId);
    if (selfIds.length > 0) {
      db.delete(interactions)
        .where(and(eq(interactions.source, "gmail"), inArray(interactions.contactId, selfIds)))
        .run();
      for (const id of selfIds) recomputeContact(id);
    }
  }
  db.update(integrationAccounts)
    .set({ gmailBackfillDone: false, updatedAt: Date.now() })
    .where(eq(integrationAccounts.id, account.id))
    .run();
}

/** One sync tick. Returns null when no active Google account exists. */
export async function runGmailSync(): Promise<GmailSyncStats | null> {
  const account = getAccount("google");
  if (!account || account.status === "revoked") return null;
  const token = await accessTokenFor(account);
  const myAddresses = myAddressList(account);

  const stats: GmailSyncStats = {
    messagesSeen: 0,
    bulkSkipped: 0,
    interactionsAdded: 0,
    contactsTouched: 0,
    backfillDone: account.gmailBackfillDone,
    unmatchedTop: [],
  };
  const unmatched = new Map<string, number>();
  const touched = new Set<number>();
  const sightings: SightingInput[] = [];

  const runId = db
    .insert(syncRuns)
    .values({
      kind: "gmail",
      status: "running",
      cursorBefore: account.gmailHistoryId,
      startedAt: Date.now(),
    })
    .returning({ id: syncRuns.id })
    .get().id;

  const budget: RateBudget = { remainingMs: RATE_LIMIT_RUN_BUDGET_MS };
  let paused: string | null = null;
  try {
    try {
      // Ids a previous run listed but couldn't fetch come first; only an
      // empty queue lets this run ask for more.
      const drained = await drainPending(token, myAddresses, stats, unmatched, touched, sightings, budget);
      if (drained && !account.gmailBackfillDone) {
        await backfillStep(account.id, token, myAddresses, stats, unmatched, touched, sightings, budget);
      } else if (drained) {
        await incrementalStep(account.id, token, myAddresses, stats, unmatched, touched, sightings, budget);
      }
    } catch (err) {
      // The listing or history call itself hit the per-minute quota (the
      // metadata fetches never throw for it). Nothing was lost: cursors
      // only move after their ids are stored or queued.
      if (!(err instanceof GmailRateLimited)) throw err;
      paused = `Google's per-minute Gmail quota was hit after ${stats.messagesSeen} messages; the sync resumes in a couple of minutes from where it stopped.`;
    }
    const queued = getPending();
    if (queued) {
      paused = `Google's per-minute Gmail quota was hit; ${queued.ids.length} listed messages are queued and the sync resumes in a couple of minutes.`;
    }
    if (paused) stats.resumeSoon = true;

    for (const id of touched) recomputeContact(id);
    recordSightings(sightings, "gmail", Date.now());
    stats.contactsTouched = touched.size;
    stats.unmatchedTop = [...unmatched.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([email, count]) => ({ email, count }));

    const after = getAccount("google");
    db.update(syncRuns)
      .set({
        status: paused ? "partial" : "success",
        error: paused,
        statsJson: JSON.stringify(stats),
        cursorAfter: after?.gmailHistoryId ?? null,
        finishedAt: Date.now(),
      })
      .where(eq(syncRuns.id, runId))
      .run();
    return stats;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.update(syncRuns)
      .set({ status: "failed", error: msg, finishedAt: Date.now() })
      .where(eq(syncRuns.id, runId))
      .run();
    if (err instanceof GmailApiError && err.status === 401) {
      markAccountError(account.id, "Gmail authorization failed — reconnect.");
    }
    throw err;
  }
}

async function backfillStep(
  accountId: number,
  token: string,
  myAddresses: string[],
  stats: GmailSyncStats,
  unmatched: Map<string, number>,
  touched: Set<number>,
  sightings: SightingInput[],
  budget: RateBudget
): Promise<void> {
  let state = getSetting<BackfillState>(BACKFILL_STATE_KEY);
  if (!state) {
    // First tick: capture the incremental baseline BEFORE listing, so
    // messages arriving mid-backfill are covered by history later.
    const profile = (await gmailJson(buildProfileUrl(), token)) as {
      historyId?: string;
    };
    if (!profile.historyId) throw new Error("Gmail profile had no historyId.");
    const windowDays = getSetting<number>("sync.gmail.backfillDays") ?? 730;
    state = {
      pageToken: null,
      baselineHistoryId: profile.historyId,
      cutoffMs: Date.now() - windowDays * 24 * 3600 * 1000,
    };
    setSetting(BACKFILL_STATE_KEY, state);
  }

  let finished = false;
  for (let page = 0; page < BACKFILL_PAGES_PER_RUN && !finished; page++) {
    const listing = (await gmailJson(
      buildMessageListUrl({ pageToken: state.pageToken ?? undefined }),
      token
    )) as { messages?: { id?: string }[]; nextPageToken?: string };
    const ids = (listing.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => !!id);
    const { metas, remaining } = await fetchMetas(ids, token, budget);
    const inWindow = metas.filter((m) => m.internalDate >= state!.cutoffMs);
    processMessages(inWindow, myAddresses, stats, unmatched, touched, sightings);
    // Ids the budget didn't reach are queued (with this window's cutoff)
    // so the page cursor can still move on.
    if (remaining.length > 0) pushPending(remaining, state.cutoffMs, stats);
    // The list is newest-first: a page that dipped below the cutoff, or a
    // missing next page, ends the backfill.
    if (inWindow.length < metas.length || !listing.nextPageToken) {
      finished = true;
    } else {
      state = { ...state, pageToken: listing.nextPageToken };
      setSetting(BACKFILL_STATE_KEY, state);
    }
    if (remaining.length > 0) break; // budget spent; the next run drains the queue first
  }

  if (finished) {
    db.update(integrationAccounts)
      .set({
        gmailBackfillDone: true,
        gmailHistoryId: state.baselineHistoryId,
        updatedAt: Date.now(),
      })
      .where(eq(integrationAccounts.id, accountId))
      .run();
    setSetting(BACKFILL_STATE_KEY, null);
    stats.backfillDone = true;
  }
}

/**
 * The "last known timestamp" the SPEC's bounded re-list runs back to:
 * the last successful gmail run, else the newest stored gmail
 * interaction, else a week — each minus slack.
 */
function resyncSinceMs(): number {
  const lastRun = db
    .select({ startedAt: syncRuns.startedAt })
    .from(syncRuns)
    .where(and(eq(syncRuns.kind, "gmail"), eq(syncRuns.status, "success")))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1)
    .get();
  if (lastRun?.startedAt) return lastRun.startedAt - RESYNC_SLACK_MS;
  const lastMsg = db
    .select({ occurredAt: interactions.occurredAt })
    .from(interactions)
    .where(eq(interactions.source, "gmail"))
    .orderBy(desc(interactions.occurredAt))
    .limit(1)
    .get();
  if (lastMsg) return lastMsg.occurredAt - RESYNC_SLACK_MS;
  return Date.now() - 7 * 24 * 3600 * 1000;
}

async function incrementalStep(
  accountId: number,
  token: string,
  myAddresses: string[],
  stats: GmailSyncStats,
  unmatched: Map<string, number>,
  touched: Set<number>,
  sightings: SightingInput[],
  budget: RateBudget
): Promise<void> {
  const account = getAccount("google")!;
  const startHistoryId = account.gmailHistoryId;
  if (!startHistoryId) throw new Error("Backfill done but no historyId.");

  let pageToken: string | undefined;
  let latestHistoryId: string | null = null;
  const messageIds = new Set<string>();
  try {
    do {
      const page = parseHistoryPage(
        await gmailJson(buildHistoryListUrl({ startHistoryId, pageToken }), token)
      );
      for (const id of page.messageIds) messageIds.add(id);
      if (page.historyId) latestHistoryId = page.historyId;
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    // Expired historyId (SPEC §9 edge case): Google 404s. Reset the
    // cursor from the live profile and re-list *back to the last known
    // sync point* — a single page (500 ids) would silently skip anything
    // older after long downtime, then jump the cursor past it forever.
    // The source_key unique index makes re-processing idempotent.
    if (err instanceof GmailApiError && err.status === 404) {
      const profile = (await gmailJson(buildProfileUrl(), token)) as {
        historyId?: string;
      };
      const sinceMs = resyncSinceMs();
      let listPageToken: string | undefined;
      for (let page = 0; page < RESYNC_MAX_PAGES; page++) {
        const listing = (await gmailJson(
          buildMessageListUrl({ pageToken: listPageToken }),
          token
        )) as { messages?: { id?: string }[]; nextPageToken?: string };
        const ids = (listing.messages ?? [])
          .map((m) => m.id)
          .filter((id): id is string => !!id);
        const { metas, remaining } = await fetchMetas(ids, token, budget);
        for (const m of metas) {
          if (m.internalDate >= sinceMs) messageIds.add(m.id);
        }
        // Unfetched ids can't be date-filtered yet; queue them under the
        // re-list's own cutoff and let the drain sort them out.
        if (remaining.length > 0) pushPending(remaining, sinceMs, stats);
        // Newest-first: a page dipping below the sync point, or no next
        // page, means the gap is covered.
        if (
          metas.some((m) => m.internalDate < sinceMs) ||
          !listing.nextPageToken
        ) {
          break;
        }
        listPageToken = listing.nextPageToken;
      }
      latestHistoryId = profile.historyId ?? null;
    } else {
      throw err;
    }
  }

  const { metas, remaining } = await fetchMetas([...messageIds], token, budget);
  processMessages(metas, myAddresses, stats, unmatched, touched, sightings);
  // With the leftovers queued, the cursor may advance: nothing is lost,
  // and the next run picks the queue up before asking for new history.
  if (remaining.length > 0) pushPending(remaining, null, stats);
  if (latestHistoryId) {
    db.update(integrationAccounts)
      .set({ gmailHistoryId: latestHistoryId, updatedAt: Date.now() })
      .where(eq(integrationAccounts.id, accountId))
      .run();
  }
}
