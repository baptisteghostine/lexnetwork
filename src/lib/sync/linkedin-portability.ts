import type { LinkedInConnection } from "@/lib/imports/linkedin";
import { normalizeLinkedInUrl } from "@/lib/imports/linkedin";
import { outboundFetch } from "@/lib/net/fetch";

// LinkedIn Member Data Portability (self-serve) API — the official,
// owner-consented route to the same data as the export ZIP (SPEC §9a).
// EEA/CH members only; the owner creates their own LinkedIn developer app
// with the "Member Data Portability API (Member)" product and connects it
// in Settings. The snapshot mirrors the export archive as JSON records,
// so CONNECTIONS records feed the exact same import engine as
// Connections.csv.
//
// LinkedIn revises the available snapshot domains per API version, so we
// never assume CONNECTIONS exists: domains are discovered at connect time
// and stored on the account row; sync degrades to a clear status message
// (ZIP import stays first-class) when the domain isn't offered.

export const LINKEDIN_AUTH_URL =
  "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_TOKEN_URL =
  "https://www.linkedin.com/oauth/v2/accessToken";
export const LINKEDIN_SCOPE = "r_dma_portability_self_serve";
export const LINKEDIN_VERSION = "202312";
const SNAPSHOT_URL = "https://api.linkedin.com/rest/memberSnapshotData";

export function buildLinkedInAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: LINKEDIN_SCOPE,
    state: opts.state,
  });
  return `${LINKEDIN_AUTH_URL}?${params.toString()}`;
}

export type LinkedInTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

export async function exchangeLinkedInCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  now?: number;
}): Promise<LinkedInTokens> {
  const res = await outboundFetch(LINKEDIN_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
    }).toString(),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(
      `LinkedIn token endpoint: ${json.error ?? res.status} ${json.error_description ?? ""}`.trim()
    );
  }
  const now = opts.now ?? Date.now();
  return {
    accessToken: json.access_token,
    // Self-serve apps typically get no refresh token — the ~60-day access
    // token expires and the UI asks the owner to reconnect.
    refreshToken: json.refresh_token ?? null,
    expiresAt: now + (json.expires_in ?? 60 * 24 * 3600) * 1000,
  };
}

export function buildSnapshotUrl(opts: {
  domain?: string;
  start?: number;
}): string {
  const params = new URLSearchParams({ q: "criteria" });
  if (opts.domain) params.set("domain", opts.domain);
  if (opts.start !== undefined) params.set("start", String(opts.start));
  return `${SNAPSHOT_URL}?${params.toString()}`;
}

export function snapshotHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

// ---------- response parsing ----------

export type SnapshotRecord = Record<string, string>;

type RawSnapshotPage = {
  elements?: { snapshotDomain?: string; snapshotData?: unknown[] }[];
  paging?: { start?: number; count?: number; total?: number };
};

export function parseSnapshotPage(raw: unknown): {
  domains: string[];
  records: SnapshotRecord[];
  /** Next `start` value, or null when this page is the last. */
  nextStart: number | null;
} {
  const page = raw as RawSnapshotPage;
  const domains: string[] = [];
  const records: SnapshotRecord[] = [];
  for (const el of page.elements ?? []) {
    if (el.snapshotDomain) domains.push(el.snapshotDomain);
    for (const rec of el.snapshotData ?? []) {
      if (rec && typeof rec === "object" && !Array.isArray(rec)) {
        const clean: SnapshotRecord = {};
        for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
          if (typeof v === "string") clean[k] = v;
        }
        records.push(clean);
      }
    }
  }
  const paging = page.paging;
  let nextStart: number | null = null;
  if (
    paging &&
    typeof paging.start === "number" &&
    typeof paging.count === "number" &&
    typeof paging.total === "number" &&
    paging.start + paging.count < paging.total
  ) {
    nextStart = paging.start + paging.count;
  }
  return { domains: [...new Set(domains)], records, nextStart };
}

// ---------- CONNECTIONS record mapping ----------

/** Lowercase and strip non-alphanumerics: "First Name" → "firstname". */
function keyOf(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const FIELD_KEYS = {
  firstName: ["firstname"],
  lastName: ["lastname"],
  url: ["url", "profileurl"],
  email: ["emailaddress", "email"],
  company: ["company"],
  position: ["position", "title"],
  connectedOn: ["connectedon", "connecteddate"],
  // Speculative, like the rest of this key-tolerant mapper: the DMA
  // snapshot mirrors Connections.csv, which has no location column — but
  // if a record ever carries one, taking it costs nothing.
  location: ["location", "geolocation", "geolocationname", "locationname"],
} as const;

function pick(
  rec: Map<string, string>,
  keys: readonly string[]
): string | null {
  for (const k of keys) {
    const v = rec.get(k);
    if (v !== undefined && v.trim() !== "") return v.trim();
  }
  return null;
}

/**
 * Map one CONNECTIONS snapshot record to the shape the ZIP import engine
 * consumes. Tolerant of header variants — the snapshot mirrors
 * Connections.csv, whose column set LinkedIn has changed before.
 * Returns null for records with no usable identity (no name and no URL).
 */
export function mapConnectionRecord(
  rec: SnapshotRecord
): LinkedInConnection | null {
  const byKey = new Map(Object.entries(rec).map(([k, v]) => [keyOf(k), v]));
  const firstName = pick(byKey, FIELD_KEYS.firstName) ?? "";
  const lastName = pick(byKey, FIELD_KEYS.lastName) ?? "";
  const urlRaw = pick(byKey, FIELD_KEYS.url);
  if (!firstName && !lastName && !urlRaw) return null;
  return {
    firstName,
    lastName,
    profileUrl: urlRaw ? normalizeLinkedInUrl(urlRaw) : null,
    profileUrlRaw: urlRaw,
    email: pick(byKey, FIELD_KEYS.email),
    company: pick(byKey, FIELD_KEYS.company),
    position: pick(byKey, FIELD_KEYS.position),
    connectedOn: pick(byKey, FIELD_KEYS.connectedOn),
    location: pick(byKey, FIELD_KEYS.location),
  };
}
