import "server-only";

import { eq } from "drizzle-orm";

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
  parseHistoryPage,
  parseMessageMeta,
  resolveDirection,
  type GmailMessageMeta,
} from "@/lib/sync/gmail";
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
const METADATA_CONCURRENCY = 8;
const BACKFILL_STATE_KEY = "sync.gmail.backfill";

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

async function gmailJson(url: string, token: string): Promise<unknown> {
  const res = await outboundFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new GmailApiError(res.status, await res.text());
  return res.json();
}

async function fetchMetas(
  ids: string[],
  token: string
): Promise<GmailMessageMeta[]> {
  const out: GmailMessageMeta[] = [];
  for (let i = 0; i < ids.length; i += METADATA_CONCURRENCY) {
    const chunk = ids.slice(i, i + METADATA_CONCURRENCY);
    const metas = await Promise.all(
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
  touched: Set<number>
): void {
  for (const meta of metas) {
    stats.messagesSeen++;
    const { direction, counterparts } = resolveDirection(meta, myAddresses);
    if (counterparts.length === 0) continue;
    const matches = contactIdsByEmail(counterparts);
    for (const address of counterparts) {
      const contactId = matches.get(address);
      if (contactId === undefined) {
        unmatched.set(address, (unmatched.get(address) ?? 0) + 1);
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

  try {
    if (!account.gmailBackfillDone) {
      await backfillStep(account.id, token, myAddresses, stats, unmatched, touched);
    } else {
      await incrementalStep(account.id, token, myAddresses, stats, unmatched, touched);
    }

    for (const id of touched) recomputeContact(id);
    stats.contactsTouched = touched.size;
    stats.unmatchedTop = [...unmatched.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([email, count]) => ({ email, count }));

    const after = getAccount("google");
    db.update(syncRuns)
      .set({
        status: "success",
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
  touched: Set<number>
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
    const metas = await fetchMetas(ids, token);
    const inWindow = metas.filter((m) => m.internalDate >= state!.cutoffMs);
    processMessages(inWindow, myAddresses, stats, unmatched, touched);
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

async function incrementalStep(
  accountId: number,
  token: string,
  myAddresses: string[],
  stats: GmailSyncStats,
  unmatched: Map<string, number>,
  touched: Set<number>
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
    // cursor from the live profile and re-list one recent page — the
    // source_key unique index makes re-processing idempotent.
    if (err instanceof GmailApiError && err.status === 404) {
      const profile = (await gmailJson(buildProfileUrl(), token)) as {
        historyId?: string;
      };
      const listing = (await gmailJson(buildMessageListUrl({}), token)) as {
        messages?: { id?: string }[];
      };
      for (const m of listing.messages ?? []) if (m.id) messageIds.add(m.id);
      latestHistoryId = profile.historyId ?? null;
    } else {
      throw err;
    }
  }

  const metas = await fetchMetas([...messageIds], token);
  processMessages(metas, myAddresses, stats, unmatched, touched);
  if (latestHistoryId) {
    db.update(integrationAccounts)
      .set({ gmailHistoryId: latestHistoryId, updatedAt: Date.now() })
      .where(eq(integrationAccounts.id, accountId))
      .run();
  }
}
