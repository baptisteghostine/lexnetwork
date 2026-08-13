import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { integrationAccounts } from "@/db/schema";
import { getSessionSecret } from "@/lib/auth/secret";
import { decryptToken, encryptToken } from "@/lib/crypto";
import { getSetting } from "@/lib/settings";
import { refreshGoogleToken } from "@/lib/sync/google-auth";

// Account-row plumbing shared by the sync engines and the OAuth callback
// routes: encrypted token storage, refresh-on-expiry, status transitions.

export type IntegrationAccount = typeof integrationAccounts.$inferSelect;

export function getAccount(
  provider: "google" | "linkedin"
): IntegrationAccount | undefined {
  return db
    .select()
    .from(integrationAccounts)
    .where(eq(integrationAccounts.provider, provider))
    .get();
}

export function upsertAccount(opts: {
  provider: "google" | "linkedin";
  accountEmail: string;
  scopes: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: number;
  myAddresses?: string[];
  linkedinDomains?: string[];
}): IntegrationAccount {
  const secret = getSessionSecret();
  const now = Date.now();
  const values = {
    accountEmail: opts.accountEmail,
    scopes: opts.scopes,
    accessToken: encryptToken(opts.accessToken, secret),
    refreshToken: opts.refreshToken
      ? encryptToken(opts.refreshToken, secret)
      : null,
    tokenExpiresAt: opts.tokenExpiresAt,
    ...(opts.myAddresses ? { myAddresses: JSON.stringify(opts.myAddresses) } : {}),
    ...(opts.linkedinDomains
      ? { linkedinDomains: JSON.stringify(opts.linkedinDomains) }
      : {}),
    status: "active",
    lastError: null,
    updatedAt: now,
  };
  const existing = getAccount(opts.provider);
  if (existing) {
    db.update(integrationAccounts)
      .set(values)
      .where(eq(integrationAccounts.id, existing.id))
      .run();
    return getAccount(opts.provider)!;
  }
  return db
    .insert(integrationAccounts)
    .values({ provider: opts.provider, ...values, createdAt: now })
    .returning()
    .get();
}

export function markAccountError(accountId: number, message: string): void {
  db.update(integrationAccounts)
    .set({ status: "error", lastError: message, updatedAt: Date.now() })
    .where(eq(integrationAccounts.id, accountId))
    .run();
}

export function markAccountRevoked(accountId: number, message: string): void {
  db.update(integrationAccounts)
    .set({ status: "revoked", lastError: message, updatedAt: Date.now() })
    .where(eq(integrationAccounts.id, accountId))
    .run();
}

export function disconnectAccount(provider: "google" | "linkedin"): void {
  db.delete(integrationAccounts)
    .where(eq(integrationAccounts.provider, provider))
    .run();
}

export function myAddressList(account: IntegrationAccount): string[] {
  try {
    const parsed = JSON.parse(account.myAddresses ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((a): a is string => typeof a === "string");
    }
  } catch {
    // fall through
  }
  return [account.accountEmail];
}

export function googleClientCreds(): {
  clientId: string;
  clientSecret: string;
} | null {
  const clientId = getSetting<string>("google.client_id");
  const clientSecret = getSetting<string>("google.client_secret");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function linkedinClientCreds(): {
  clientId: string;
  clientSecret: string;
} | null {
  const clientId = getSetting<string>("linkedin.client_id");
  const clientSecret = getSetting<string>("linkedin.client_secret");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Decrypt the stored access token, refreshing through Google first when
 * it expires within two minutes. LinkedIn self-serve tokens have no
 * refresh path — expiry surfaces as a "reconnect" error status.
 */
export async function accessTokenFor(
  account: IntegrationAccount
): Promise<string> {
  const secret = getSessionSecret();
  const stored = account.accessToken
    ? decryptToken(account.accessToken, secret)
    : null;
  if (stored === null) {
    markAccountError(
      account.id,
      "Stored token unreadable (secret rotated?) — reconnect the account."
    );
    throw new Error("Token unreadable — account needs reconnecting.");
  }
  const now = Date.now();
  if ((account.tokenExpiresAt ?? 0) > now + 2 * 60 * 1000) return stored;

  if (account.provider !== "google") {
    markAccountError(
      account.id,
      "LinkedIn access token expired — reconnect the account in Settings."
    );
    throw new Error("LinkedIn token expired.");
  }
  const refresh = account.refreshToken
    ? decryptToken(account.refreshToken, secret)
    : null;
  const creds = googleClientCreds();
  if (!refresh || !creds) {
    markAccountError(
      account.id,
      "No usable refresh token — reconnect the account."
    );
    throw new Error("Google token expired with no refresh path.");
  }
  try {
    const fresh = await refreshGoogleToken({
      refreshToken: refresh,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    });
    db.update(integrationAccounts)
      .set({
        accessToken: encryptToken(fresh.accessToken, secret),
        tokenExpiresAt: fresh.expiresAt,
        status: "active",
        lastError: null,
        updatedAt: Date.now(),
      })
      .where(eq(integrationAccounts.id, account.id))
      .run();
    return fresh.accessToken;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // invalid_grant = the owner revoked access in their Google account.
    if (msg.includes("invalid_grant")) {
      markAccountRevoked(account.id, "Google access revoked — reconnect.");
    } else {
      markAccountError(account.id, `Token refresh failed: ${msg}`);
    }
    throw err;
  }
}
