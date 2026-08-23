// Nominatim geocoding, pure parts (SPEC §7a city placement, decision #4).
// The job in server/sync/geocode.ts does the fetching and writing; this
// file builds URLs, reads responses, and groups points — all unit-testable
// without a network.
//
// Nominatim is OpenStreetMap's free geocoder: no account, no key, no tier
// to outgrow. Its usage policy is the constraint the job is shaped around
// — at most one request per second, a User-Agent that identifies the
// application, and results cached rather than re-asked. Rolo geocodes
// each *distinct location string* once, ever, and fans the answer out to
// every contact sharing the string — 2,000 contacts are usually only a
// few hundred lookups.

/** Nominatim policy: max 1 req/s. A little slack on top. */
export const GEOCODE_DELAY_MS = 1100;

/**
 * Distinct strings per job run. The scheduler reclaims a 'running' job
 * after 5 minutes (LEASE_MS); 150 × 1.1s ≈ 2¾ min keeps a full batch
 * safely inside its lease. The recurring job picks up the remainder.
 */
export const GEOCODE_BATCH_MAX = 150;

/** A miss is retried after this long — OSM data improves, slowly. */
export const GEOCODE_RETRY_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

/** Identifies the app per Nominatim's policy. No owner data in it. */
export const GEOCODE_USER_AGENT = "Rolo/1.0 (self-hosted personal CRM)";

export function nominatimUrl(location: string): string {
  const params = new URLSearchParams({
    q: location,
    format: "jsonv2",
    limit: "1",
    // English names keep coordinates language-independent and responses
    // small; we only read lat/lon anyway.
    "accept-language": "en",
  });
  return `https://nominatim.openstreetmap.org/search?${params.toString()}`;
}

export type GeoPoint = { lat: number; lng: number };

function toCoord(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : NaN;
  return Number.isFinite(n) ? n : null;
}

/** First result's coordinates, or null — an empty array is Nominatim's
 * normal "no idea", not an error. */
export function parseNominatimResponse(payload: unknown): GeoPoint | null {
  if (!Array.isArray(payload) || payload.length === 0) return null;
  const first = payload[0] as { lat?: unknown; lon?: unknown };
  if (typeof first !== "object" || first === null) return null;
  const lat = toCoord(first.lat);
  const lng = toCoord(first.lon);
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// ---------- grouping geocoded contacts into city pins ----------

export type CityPin = {
  /** Stable key for selection URLs: the anchor's "lat,lng". */
  key: string;
  lat: number;
  lng: number;
  /** Most common location string in the group — the pin's name. */
  label: string;
  count: number;
};

export function cityKey(lat: number, lng: number): string {
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}

/** ~5 km. "Zurich, Switzerland" and "Zürich, Zurich, Switzerland" geocode
 * a few hundred metres apart and must be one pin. Clustering by distance
 * to a group anchor, not by rounding to a grid — grid cells split points
 * that sit either side of a cell boundary however close they are. */
const CLUSTER_DEGREES = 0.05;

/**
 * Greedy anchor clustering, deterministic via a canonical sort. Generic so
 * the caller can keep whatever it attached to each row (the map keeps the
 * contact) and read the group's members back out.
 */
export function groupCityPins<
  T extends { location: string; lat: number; lng: number },
>(rows: T[]): (CityPin & { members: T[] })[] {
  const sorted = [...rows].sort(
    (a, b) =>
      a.lat - b.lat || a.lng - b.lng || a.location.localeCompare(b.location)
  );
  const groups: {
    anchor: { lat: number; lng: number };
    members: T[];
    labels: Map<string, number>;
  }[] = [];
  for (const r of sorted) {
    let g = groups.find(
      (cand) =>
        Math.abs(cand.anchor.lat - r.lat) <= CLUSTER_DEGREES &&
        Math.abs(cand.anchor.lng - r.lng) <= CLUSTER_DEGREES
    );
    if (!g) {
      g = { anchor: { lat: r.lat, lng: r.lng }, members: [], labels: new Map() };
      groups.push(g);
    }
    g.members.push(r);
    g.labels.set(r.location, (g.labels.get(r.location) ?? 0) + 1);
  }
  return groups
    .map((g) => {
      let label = "";
      let best = 0;
      for (const [text, n] of g.labels) {
        if (n > best) {
          best = n;
          label = text;
        }
      }
      // The pin shows the city half of "Zurich, Zurich, Switzerland" —
      // the country is visible under it on the map.
      const short = label.split(",")[0]?.trim() || label;
      return {
        key: cityKey(g.anchor.lat, g.anchor.lng),
        lat: g.anchor.lat,
        lng: g.anchor.lng,
        label: short,
        count: g.members.length,
        members: g.members,
      };
    })
    .sort((a, b) => b.count - a.count);
}
