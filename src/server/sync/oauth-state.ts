import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { getSessionSecret } from "@/lib/auth/secret";

// CSRF state for the OAuth redirects: HMAC over an issue timestamp,
// verified on callback within a 15-minute window. No server-side storage
// needed — same trick as the session cookie.

const WINDOW_MS = 15 * 60 * 1000;

function sign(payload: string): string {
  return createHmac("sha256", `${getSessionSecret()}:oauth-state`)
    .update(payload)
    .digest("base64url");
}

export function issueOauthState(now: number = Date.now()): string {
  const payload = String(now);
  return `${payload}.${sign(payload)}`;
}

export function verifyOauthState(
  state: string | null,
  now: number = Date.now()
): boolean {
  if (!state) return false;
  const dot = state.indexOf(".");
  if (dot <= 0) return false;
  const payload = state.slice(0, dot);
  const mac = state.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const issued = Number(payload);
  return Number.isFinite(issued) && now - issued < WINDOW_MS && issued <= now;
}
