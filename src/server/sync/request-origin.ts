import type { NextRequest } from "next/server";

/**
 * The browser-visible origin for this request. Next.js's `NextRequest.url`
 * reflects the connection the app server itself sees, not what the browser
 * used — behind a reverse proxy that terminates TLS upstream (Codespaces,
 * Gitpod, most production setups), that's plain `http://` on an internal
 * host/port, not the public `https://` domain. OAuth redirect URIs must
 * match the provider-registered, browser-visible URL exactly, so every
 * absolute URL built for an OAuth round trip goes through this instead of
 * `req.url` directly.
 */
export function publicOrigin(req: NextRequest | Request): string {
  return publicOriginFromHeaders(req.headers, req.url);
}

/**
 * The same, from bare headers — for server components and actions, which
 * have `headers()` but no request object. `fallbackUrl` is the request's
 * own URL when there is one.
 */
export function publicOriginFromHeaders(headers: Headers, fallbackUrl?: string): string {
  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : null;
  const rawHost =
    headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? headers.get("host");
  // A header is whatever the sender typed. Only something that is plainly
  // a host (name or bracketed IPv6, optional port) becomes part of an
  // origin; anything else falls through to the request's own address.
  const host = rawHost && HOST_RE.test(rawHost) ? rawHost.toLowerCase() : null;
  if (proto && host) return `${proto}://${host}`;
  if (fallbackUrl) {
    try {
      return new URL(fallbackUrl).origin;
    } catch {
      // fall through
    }
  }
  // No proxy announced a scheme: a direct connection, which is plain http.
  return host ? `http://${host}` : "http://localhost:3000";
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;
