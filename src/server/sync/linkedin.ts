import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { integrationAccounts, syncRuns } from "@/db/schema";
import type { LinkedInConnection } from "@/lib/imports/linkedin";
import { outboundFetch } from "@/lib/net/fetch";
import {
  buildSnapshotUrl,
  mapConnectionRecord,
  parseSnapshotPage,
  snapshotHeaders,
} from "@/lib/sync/linkedin-portability";
import { executeLinkedInRows } from "@/server/linkedin-import";
import {
  accessTokenFor,
  getAccount,
  markAccountError,
} from "@/server/sync/accounts";

// LinkedIn Member Data Portability sync (SPEC §9a): pull the CONNECTIONS
// snapshot through the official consented API and feed it to the exact
// import core the ZIP upload uses — same identity ladder, same provenance
// rules, same job-change detection. The ZIP ritual stays first-class;
// this automates it for EEA/CH owners.

const MAX_SNAPSHOT_PAGES = 500;

export type LinkedInSyncResult =
  | { ran: false; reason: string }
  | { ran: true; runId: number; total: number };

class LinkedInApiError extends Error {
  constructor(
    public status: number,
    body: string
  ) {
    super(`LinkedIn API ${status}: ${body.slice(0, 300)}`);
  }
}

async function linkedinJson(url: string, token: string): Promise<unknown> {
  const res = await outboundFetch(url, { headers: snapshotHeaders(token) });
  if (!res.ok) throw new LinkedInApiError(res.status, await res.text());
  return res.json();
}

/**
 * Enumerate the snapshot domains this token can pull. Called at connect
 * time (and re-checked on sync) because LinkedIn varies the domain set
 * per product/version — CONNECTIONS is the one we need but must not
 * assume.
 */
export async function discoverSnapshotDomains(
  accessToken: string
): Promise<string[]> {
  const domains = new Set<string>();
  let start: number | undefined;
  for (let page = 0; page < 50; page++) {
    const parsed = parseSnapshotPage(
      await linkedinJson(buildSnapshotUrl({ start }), accessToken)
    );
    for (const d of parsed.domains) domains.add(d);
    if (parsed.nextStart === null) break;
    start = parsed.nextStart;
  }
  return [...domains].sort();
}

async function fetchConnectionRecords(
  accessToken: string
): Promise<LinkedInConnection[]> {
  const rows: LinkedInConnection[] = [];
  let start: number | undefined;
  for (let page = 0; page < MAX_SNAPSHOT_PAGES; page++) {
    const parsed = parseSnapshotPage(
      await linkedinJson(
        buildSnapshotUrl({ domain: "CONNECTIONS", start }),
        accessToken
      )
    );
    for (const rec of parsed.records) {
      const mapped = mapConnectionRecord(rec);
      if (mapped) rows.push(mapped);
    }
    if (parsed.nextStart === null) break;
    start = parsed.nextStart;
  }
  return rows;
}

/** One sync run. Returns why it didn't run when it can't. */
export async function runLinkedInSync(): Promise<LinkedInSyncResult> {
  const account = getAccount("linkedin");
  if (!account) return { ran: false, reason: "LinkedIn is not connected." };
  if (account.status === "revoked") {
    return { ran: false, reason: "LinkedIn access was revoked — reconnect." };
  }
  const token = await accessTokenFor(account);

  // Re-discover domains each run: cheap, and LinkedIn has changed the
  // offered set before. An account whose product gains CONNECTIONS later
  // starts syncing without a reconnect.
  let domains: string[];
  try {
    domains = await discoverSnapshotDomains(token);
    db.update(integrationAccounts)
      .set({ linkedinDomains: JSON.stringify(domains), updatedAt: Date.now() })
      .where(eq(integrationAccounts.id, account.id))
      .run();
  } catch (err) {
    if (err instanceof LinkedInApiError && err.status === 401) {
      markAccountError(account.id, "LinkedIn authorization failed — reconnect.");
    }
    throw err;
  }

  if (!domains.includes("CONNECTIONS")) {
    const reason =
      "This LinkedIn app's snapshot does not expose the CONNECTIONS domain " +
      `(available: ${domains.join(", ") || "none"}). Keep using the ZIP ` +
      "import — it covers everything the API would.";
    db.insert(syncRuns)
      .values({
        kind: "linkedin_api_sync",
        status: "failed",
        error: reason,
        startedAt: Date.now(),
        finishedAt: Date.now(),
      })
      .run();
    return { ran: false, reason };
  }

  const connections = await fetchConnectionRecords(token);
  const { runId, report } = executeLinkedInRows({
    connections,
    // Messages aren't part of the CONNECTIONS snapshot; the ZIP path
    // remains the way conversations enter the timeline.
    messages: [],
    ownerName: null,
    runKind: "linkedin_api_sync",
  });

  db.update(integrationAccounts)
    .set({ linkedinSnapshotAt: Date.now(), updatedAt: Date.now() })
    .where(eq(integrationAccounts.id, account.id))
    .run();

  return { ran: true, runId, total: report.stats.total };
}
