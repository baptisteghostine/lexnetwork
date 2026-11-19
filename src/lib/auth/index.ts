import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { getPasswordHash } from "./password-gate";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifySessionToken,
} from "./session";

export { getSessionSecret } from "./secret";
import { getSessionSecret } from "./secret";

// The password and its throttle live in password-gate.ts, which has no
// next/headers dependency; re-exported so callers keep one import.
export {
  attemptPassword,
  getLoginThrottle,
  getPasswordHash,
  setLoginThrottle,
  setPasswordHash,
} from "./password-gate";

export async function isAuthenticated(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  return verifySessionToken(token, getSessionSecret());
}

/** Call at the top of every protected page/action. Redirects when not usable. */
export async function requireAuth(): Promise<void> {
  if (!getPasswordHash()) redirect("/setup");
  if (!(await isAuthenticated())) redirect("/login");
}

export async function startSession(): Promise<void> {
  const jar = await cookies();
  // Phase 11 deploy hardening: `next start` never terminates TLS itself, so
  // HTTPS always means a reverse proxy in front — which announces itself
  // via X-Forwarded-Proto. Mark the cookie Secure exactly then; a plain
  // http LAN/dev deployment still gets a working login.
  const proto = (await headers()).get("x-forwarded-proto") ?? "";
  jar.set(SESSION_COOKIE, createSessionToken(getSessionSecret()), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
    secure: proto.split(",")[0]?.trim() === "https",
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}
