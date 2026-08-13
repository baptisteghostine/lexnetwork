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
  // Anthropic API (Phase 10)
  "api.anthropic.com",
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

/** The only sanctioned way to make an outbound HTTP request. */
export async function outboundFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  if (!isAllowedOutboundUrl(url)) throw new OutboundBlockedError(url);
  return fetch(url, init);
}
