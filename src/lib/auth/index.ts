import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { getSetting, setSetting } from "@/lib/settings";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifySessionToken,
} from "./session";

const PASSWORD_HASH_KEY = "auth.password_hash";

export { getSessionSecret } from "./secret";
import { getSessionSecret } from "./secret";

export function getPasswordHash(): string | undefined {
  return getSetting<string>(PASSWORD_HASH_KEY);
}

export function setPasswordHash(hash: string): void {
  setSetting(PASSWORD_HASH_KEY, hash);
}

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
