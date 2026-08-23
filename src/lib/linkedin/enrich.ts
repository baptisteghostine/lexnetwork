// Profile-location enrichment (SPEC §9d). Pure — no DB, no network.
//
// Why this exists at all: LinkedIn's connections endpoint carries no
// geography. Verified against a live payload on 2026-08-23 — every key in
// the whole response, at every depth, and not one of `location`, `geo`,
// `geoRegion` or `country` among them. The list API returns names,
// headlines and photos. Location lives on the individual profile, one
// request per person, which is why this is a slow trickle rather than
// something the weekly sync can do in passing.
//
// The shape of the answer follows from that cost. 2000+ connections at a
// browsing-speed pace is weeks of work, so the queue is ordered by who the
// owner actually cares about (the map is useful long before it is
// complete), capped per day, and each contact is fetched once rather than
// every sync — locations barely move.

/** How long before an already-checked contact is eligible again. Locations
 * change on the order of years; re-asking sooner spends the daily budget
 * on people we already know about. */
export const RECHECK_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

/** Default profiles per day. Roughly seven minutes of paced requests —
 * indistinguishable from a person reading LinkedIn, which is the property
 * that keeps an account unflagged. */
export const DEFAULT_DAILY_CAP = 100;

/** Ceiling on the setting, so a well-meaning "just do it faster" can't turn
 * the trickle into the burst this design exists to avoid. */
export const MAX_DAILY_CAP = 300;

export function clampDailyCap(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_DAILY_CAP;
  }
  return Math.max(1, Math.min(MAX_DAILY_CAP, Math.floor(value)));
}

export type EnrichCandidate = {
  contactId: number;
  publicIdentifier: string;
  starred: boolean;
  hasCadence: boolean;
  lastInteractionAt: number | null;
  createdAt: number;
};

/**
 * Queue order: starred, then anyone on a keep-in-touch cadence, then most
 * recently interacted with, then newest contact.
 *
 * The point is that the map earns its keep on day one. Filling in 2000
 * people alphabetically would mean three weeks of a half-drawn map that
 * tells the owner nothing; filling in the ~100 people they actually track
 * means the first morning's map is already the one they'd want.
 */
export function rankCandidates(candidates: EnrichCandidate[]): EnrichCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      Number(b.starred) - Number(a.starred) ||
      Number(b.hasCadence) - Number(a.hasCadence) ||
      (b.lastInteractionAt ?? 0) - (a.lastInteractionAt ?? 0) ||
      b.createdAt - a.createdAt ||
      a.contactId - b.contactId
  );
}

/** What the extension may fetch right now: the ranked head of the queue,
 * trimmed to whatever is left of today's budget. */
export function nextBatch(
  candidates: EnrichCandidate[],
  opts: { batchSize: number; dailyCap: number; checkedToday: number }
): EnrichCandidate[] {
  const remaining = Math.max(0, opts.dailyCap - opts.checkedToday);
  const take = Math.min(remaining, Math.max(0, opts.batchSize));
  return rankCandidates(candidates).slice(0, take);
}

/**
 * The public identifier in a stored LinkedIn URL — "linkedin.com/in/ana-silva"
 * → "ana-silva". Company pages, school pages and post URLs are not people
 * and must not enter the queue.
 */
export function publicIdentifierFromUrl(url: string): string | null {
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!match) return null;
  const id = match[1].trim().toLowerCase();
  return id === "" ? null : id;
}

// ---------- reading a location out of a profile response ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keys LinkedIn has used for a human-readable place. Ordered by how
 * specific they are: a full "Zurich, Zurich, Switzerland" beats a bare
 * country, because the country resolver can always narrow but never widen.
 */
const LOCATION_KEYS = [
  "geoLocationName",
  "locationName",
  "defaultLocalizedName",
  "geoRegionName",
  "displayName",
  "location",
  "geoLocation",
  "geoRegion",
  "country",
  "countryName",
];

/** Values that are structurally a location but say nothing. */
function usableLocation(value: string): boolean {
  const v = value.trim();
  if (v.length < 2 || v.length > 120) return false;
  // URNs and opaque ids leak through the same keys ("urn:li:fs_geo:1234").
  if (/^urn:/i.test(v) || /^[0-9]+$/.test(v)) return false;
  return true;
}

/**
 * Pull a location out of a profile payload structurally, exactly like the
 * connections parser: search for keys that look like a place anywhere in
 * the response rather than walking a fixed path. This is an undocumented
 * API whose shape drifts; a rename must cost us a field, not the feature.
 *
 * Returns null when nothing usable is found — which is a legitimate
 * outcome, not an error. Plenty of profiles genuinely have no location set.
 */
export function extractLocation(payload: unknown, maxDepth = 10): string | null {
  const found = new Map<string, string>();

  const walk = (value: unknown, depth: number): void => {
    if (depth > maxDepth) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    for (const key of LOCATION_KEYS) {
      if (found.has(key)) continue;
      const raw = value[key];
      if (typeof raw === "string" && usableLocation(raw)) {
        found.set(key, raw.trim());
      }
    }
    for (const item of Object.values(value)) walk(item, depth + 1);
  };
  walk(payload, 0);

  for (const key of LOCATION_KEYS) {
    const hit = found.get(key);
    if (hit !== undefined) return hit;
  }
  return null;
}

export type EnrichResult = {
  publicIdentifier: string;
  /** null = looked, found nothing. The contact is still stamped as checked. */
  location: string | null;
};

/**
 * Summary of one enrichment round, for the sync-run report and the popup.
 * `missing` is a first-class outcome, not an error — but `attempted > 0`
 * with everything missing means the response shape probably drifted, and
 * the caller says so rather than reporting a clean run.
 */
export type EnrichSummary = {
  attempted: number;
  located: number;
  missing: number;
};

export function summarize(results: EnrichResult[]): EnrichSummary {
  const located = results.filter((r) => r.location !== null).length;
  return {
    attempted: results.length,
    located,
    missing: results.length - located,
  };
}

/**
 * Fail-loud check, same rule as the connection sync: a round where every
 * single profile came back placeless is far more likely to be a parser
 * that stopped matching than 40 consecutive people who hid their city.
 * Below this many attempts the sample is too small to accuse anyone.
 */
export const DRIFT_SUSPICION_MIN = 10;

export function driftWarning(summary: EnrichSummary): string | null {
  if (summary.attempted < DRIFT_SUSPICION_MIN) return null;
  if (summary.located > 0) return null;
  return `None of the ${summary.attempted} profiles read in this round carried a location. That is more likely a change in LinkedIn's response shape than a coincidence — check the location keys in src/lib/linkedin/enrich.ts.`;
}
