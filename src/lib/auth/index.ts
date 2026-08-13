import "server-only";

import { cookies } from "next/headers";
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
  jar.set(SESSION_COOKIE, createSessionToken(getSessionSecret()), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
    // secure: intentionally unset for now — revisit in Phase 11 deploy
    // hardening (VPS deployments will sit behind TLS at the reverse proxy).
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}
