import "server-only";

import { and, desc, eq } from "drizzle-orm";

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
  interactionsAdded: number;
  contactsTouched: number;
  backfillDone: boolean;
  /** Set when Google's per-minute quota cut the run short: the cursor is
   * saved, and the scheduler should come back sooner than the interval. */
  resumeSoon?: boolean;
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

async function fetchMetas(
  ids: string[],
  token: string,
  budget: RateBudget
): Promise<GmailMessageMeta[]> {
  const out: GmailMessageMeta[] = [];
  for (let i = 0; i < ids.length; i += METADATA_CONCURRENCY) {
    const chunk = ids.slice(i, i + METADATA_CONCURRENCY);
    let metas: (GmailMessageMeta | null)[] | null = null;
    for (let attempt = 0; metas === null; attempt++) {
      try {
        metas = await fetchChunk(chunk, token);
      } catch (err) {
        // Quota hit: pause and retry the same chunk while this run has
        // waiting budget left; past that, let the run end "partial" —
        // the caller saved its cursor, the next tick picks it up.
        if (!(err instanceof GmailRateLimited)) throw err;
        const wait = RATE_LIMIT_RETRY_MS[attempt];
        if (wait === undefined || wait > budget.remainingMs) throw err;
        budget.remainingMs -= wait;
        await sleep(wait);
      }
    }
    for (const m of metas) if (m) out.push(m);
  }
  return out;
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
        .onConflictDoNothing()
        .run();
      if (inserted.changes > 0) {
        stats.interactionsAdded++;
        touched.add(contactId);
      }
    }
  }
}

/** One sync tick. Returns null when no active Google account exists. */
export async function runGmailSync(): Promise<GmailSyncStats | null> {
  const account = getAccount("google");
  if (!account || account.status === "revoked") return null;
  const token = await accessTokenFor(account);
  const myAddresses = myAddressList(account);

  const stats: GmailSyncStats = {
    messagesSeen: 0,
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
      if (!account.gmailBackfillDone) {
        await backfillStep(account.id, token, myAddresses, stats, unmatched, touched, sightings, budget);
      } else {
        await incrementalStep(account.id, token, myAddresses, stats, unmatched, touched, sightings, budget);
      }
    } catch (err) {
      // Out of waiting budget on Google's per-minute quota. Everything
      // processed so far is committed and the backfill cursor sits on the
      // page that didn't finish, so this is a pause, not a failure: keep
      // what we have, report "partial", and ask to be run again shortly.
      if (!(err instanceof GmailRateLimited)) throw err;
      paused = `Google's per-minute Gmail quota was hit after ${stats.messagesSeen} messages; the sync resumes in a couple of minutes from where it stopped.`;
      stats.resumeSoon = true;
    }

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
    const metas = await fetchMetas(ids, token, budget);
    const inWindow = metas.filter((m) => m.internalDate >= state!.cutoffMs);
    processMessages(inWindow, myAddresses, stats, unmatched, touched, sightings);
    // The list is newest-first: a page that dipped below the cutoff, or a
    // missing next page, ends the backfill.
    if (inWindow.length < metas.length || !listing.nextPageToken) {
      finished = true;
    } else {
      state = { ...state, pageToken: listing.nextPageToken };
      setSetting(BACKFILL_STATE_KEY, state);
    }
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
        const metas = await fetchMetas(ids, token, budget);
        for (const m of metas) {
          if (m.internalDate >= sinceMs) messageIds.add(m.id);
        }
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

  const metas = await fetchMetas([...messageIds], token, budget);
  processMessages(metas, myAddresses, stats, unmatched, touched, sightings);
  if (latestHistoryId) {
    db.update(integrationAccounts)
      .set({ gmailHistoryId: latestHistoryId, updatedAt: Date.now() })
      .where(eq(integrationAccounts.id, accountId))
      .run();
  }
}
