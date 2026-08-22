import "server-only";

import crypto from "node:crypto";

import { getSetting, setSetting } from "@/lib/settings";

// Pairing between Rolo and the browser extension (SPEC §9c).
//
// The extension can't use Rolo's session cookie: it posts from a
// chrome-extension:// origin, and the cookie is SameSite=Lax, so the
// browser would never send it. A bearer token the owner copies once is
// the simplest thing that actually works — and it keeps the endpoint
// closed to anything else running on localhost.

const TOKEN_KEY = "linkedin_extension.token";

export function getExtensionToken(): string | null {
  return getSetting<string>(TOKEN_KEY) ?? null;
}

/** Existing token, or a fresh one on first use. */
export function ensureExtensionToken(): string {
  const existing = getExtensionToken();
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString("base64url");
  setSetting(TOKEN_KEY, token);
  return token;
}

export function rotateExtensionToken(): string {
  const token = crypto.randomBytes(24).toString("base64url");
  setSetting(TOKEN_KEY, token);
  return token;
}

/** Constant-time compare so the endpoint can't be probed byte by byte. */
export function extensionTokenMatches(presented: string | null): boolean {
  const expected = getExtensionToken();
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
