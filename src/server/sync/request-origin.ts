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
export function publicOrigin(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host =
    req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ??
    req.headers.get("host");
  if (proto && host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}
