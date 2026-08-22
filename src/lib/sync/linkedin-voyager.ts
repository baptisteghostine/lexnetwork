import { scrubSecrets, buildVoyagerHeaders } from "@/lib/linkedin/session";
import type { LinkedInSession } from "@/lib/linkedin/session";
import {
  parseConnectionsResponse,
  type VoyagerConnection,
} from "@/lib/linkedin/voyager";
import { outboundFetch } from "@/lib/net/fetch";

/**
 * Reads the owner's own connection list from LinkedIn using their own session
 * (SPEC §9b — opt-in, breaches LinkedIn's User Agreement, risk on the owner).
 *
 * Pacing is deliberately conservative: one request at a time, a real pause
 * between pages, and a hard page cap. That is both the polite way to treat
 * someone else's servers and — practically — what keeps a personal account out
 * of trouble, since burst traffic is the thing automated-access detection
 * actually keys on.
 *
 * The client presents as the LinkedIn web app (buildVoyagerHeaders), which
 * is what lets Voyager answer at all — an owner-accepted reversal of the
 * original no-evasion clause (CLAUDE.md §LinkedIn, SPEC §9b), with the
 * account-restriction risk on the owner's account. What is NOT done, and
 * must not be added: fingerprint *randomisation*, proxy rotation, or
 * challenge/CAPTCHA solving. One stable browser signature, honest failure
 * on refusal — the job still surfaces a bounce and stops rather than
 * escalating.
 */

const CONNECTIONS_ENDPOINT =
  "https://www.linkedin.com/voyager/api/relationships/dash/connections";

const DECORATION_ID =
  "com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16";

/** LinkedIn's own web client requests 40 at a time; matching it keeps us unremarkable. */
export const PAGE_SIZE = 40;

/** Pause between pages. Slow on purpose. */
export const PAGE_DELAY_MS = 2_500;

/** Safety net against a paging bug turning into an unbounded request loop. */
export const MAX_PAGES = 250;

export class VoyagerSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoyagerSessionError";
  }
}

export class VoyagerRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "VoyagerRequestError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pageUrl(start: number): string {
  const params = new URLSearchParams({
    decorationId: DECORATION_ID,
    count: String(PAGE_SIZE),
    q: "search",
    sortType: "RECENTLY_ADDED",
    start: String(start),
  });
  return `${CONNECTIONS_ENDPOINT}?${params.toString()}`;
}

async function fetchPage(
  session: LinkedInSession,
  start: number,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await outboundFetch(pageUrl(start), {
    method: "GET",
    headers: buildVoyagerHeaders(session),
    redirect: "manual",
    signal,
  });

  // A redirect to the login page is how an expired `li_at` presents itself —
  // but it's also how LinkedIn answers a valid cookie replayed from an IP it
  // doesn't trust (datacenter/cloud hosts). The message keeps both readings
  // so a cloud test run doesn't masquerade as a dead session.
  if (response.status === 401 || response.status === 403) {
    throw new VoyagerSessionError(
      "LinkedIn rejected the saved session — the cookie has expired or been revoked, or this server's IP isn't trusted for it. Paste a fresh cookie in Settings; if it keeps failing, run Rolo from the network you browse LinkedIn on."
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw new VoyagerSessionError(
      "LinkedIn bounced the request to a login page. Either the saved session has expired, or the session is fine but LinkedIn doesn't trust this server's IP (common from cloud/datacenter hosts). Paste a fresh cookie in Settings; if it keeps failing, run Rolo from the network you browse LinkedIn on."
    );
  }
  if (response.status === 429) {
    throw new VoyagerRequestError(
      "LinkedIn rate-limited the request. The job will retry with backoff.",
      429
    );
  }
  if (!response.ok) {
    throw new VoyagerRequestError(
      `LinkedIn returned HTTP ${response.status}.`,
      response.status
    );
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // An HTML body where JSON was expected is almost always a login wall.
    throw new VoyagerSessionError(
      "LinkedIn returned a non-JSON response, which usually means the session was bounced to a login page."
    );
  }
}

export type FetchProgress = {
  pagesFetched: number;
  connectionsSoFar: number;
  total: number | null;
};

export async function fetchAllConnections(
  session: LinkedInSession,
  opts: {
    signal?: AbortSignal;
    onProgress?: (progress: FetchProgress) => void;
    /** Overridable so tests don't sleep. */
    delayMs?: number;
  } = {}
): Promise<VoyagerConnection[]> {
  const delayMs = opts.delayMs ?? PAGE_DELAY_MS;
  const byIdentifier = new Map<string, VoyagerConnection>();
  let total: number | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const start = page * PAGE_SIZE;
    let payload: unknown;
    try {
      payload = await fetchPage(session, start, opts.signal);
    } catch (error) {
      if (
        error instanceof VoyagerSessionError ||
        error instanceof VoyagerRequestError
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(scrubSecrets(message));
    }

    const parsed = parseConnectionsResponse(payload);
    total = parsed.total ?? total;

    // An empty page is the normal end-of-list signal.
    if (parsed.connections.length === 0) break;

    let addedThisPage = 0;
    for (const connection of parsed.connections) {
      if (byIdentifier.has(connection.publicIdentifier)) continue;
      byIdentifier.set(connection.publicIdentifier, connection);
      addedThisPage += 1;
    }

    opts.onProgress?.({
      pagesFetched: page + 1,
      connectionsSoFar: byIdentifier.size,
      total,
    });

    // Paging that stops yielding anything new means we've seen the whole list,
    // whatever the reported total claims.
    if (addedThisPage === 0) break;
    if (total !== null && byIdentifier.size >= total) break;

    await sleep(delayMs);
  }

  return [...byIdentifier.values()];
}
