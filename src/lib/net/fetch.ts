// Outbound-host allowlist (CLAUDE.md privacy invariant): every server-side
// HTTP call Rolo makes goes through this wrapper, and the wrapper refuses
// hosts that aren't part of an integration the owner can configure.
// Pulled forward from Phase 11 so the sync engines are born inside the
// guard rail rather than retrofitted into it. SMTP (nodemailer) is the one
// non-HTTP outbound channel and is owner-configured by definition.

const ALLOWED_HOSTS = new Set<string>([
  // Google OAuth + APIs (SPEC §9)
  "accounts.google.com",
  "oauth2.googleapis.com",
  "gmail.googleapis.com",
  "www.googleapis.com",
  // LinkedIn OAuth + Member Data Portability API (SPEC §9a)
  "www.linkedin.com",
  "api.linkedin.com",
  // AI providers (SPEC §11; Groq added by owner amendment 2026-08-20)
  "api.anthropic.com",
  "api.groq.com",
  // Nominatim geocoding, off by default (SPEC decision #4)
  "nominatim.openstreetmap.org",
]);

export function isAllowedOutboundUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && ALLOWED_HOSTS.has(parsed.hostname);
}

export class OutboundBlockedError extends Error {
  constructor(url: string) {
    super(
      `Outbound request blocked: ${url} is not on the integration allowlist.`
    );
    this.name = "OutboundBlockedError";
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * The only sanctioned way to make an outbound HTTP request. Redirects are
 * followed manually so EVERY hop is checked against the allowlist — with
 * the default `redirect: "follow"`, an allowed host answering 3xx would
 * send the request anywhere it liked, checked never.
 */
export async function outboundFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  let current = url;
  let method = init?.method?.toUpperCase() ?? "GET";
  let body = init?.body;
  let headers = init?.headers;

  for (let hop = 0; ; hop++) {
    if (!isAllowedOutboundUrl(current)) throw new OutboundBlockedError(current);
    const res = await fetch(current, {
      ...init,
      method,
      body,
      headers,
      redirect: "manual",
    });
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    if (hop >= MAX_REDIRECTS) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    const next = new URL(location, current);
    const crossOrigin = next.origin !== new URL(current).origin;
    current = next.toString();
    // 303 (and historical 301/302 practice) turns the replay into a GET;
    // credentials and bodies never travel to a different origin.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
    if (crossOrigin && headers) {
      const clean = new Headers(headers);
      clean.delete("authorization");
      clean.delete("cookie");
      headers = clean;
    }
  }
}
