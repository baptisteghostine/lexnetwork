import "server-only";

import { and, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";

import { db } from "@/db/client";
import { agentGrants } from "@/db/schema";
import { getSessionSecret } from "@/lib/auth/secret";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
  deriveToken,
  randomToken,
  REFRESH_GRACE_MS,
  REFRESH_TOKEN_TTL_MS,
  sameResource,
  scopeList,
  sha256Hex,
  verifyPkceS256,
} from "@/lib/agent/oauth";

// The life of a connector grant (SCHEMA.md `agent_grants`, SPEC §14):
//
//   consent      → a row with only the authorization-code leg set
//   exchange     → the code buys an access and a refresh token
//   refresh      → both rotate; the old refresh token is remembered
//   revoke/expiry→ nothing it issued works any more
//
// Every secret is stored as its SHA-256 and compared by indexed equality
// on the hash. Nothing here returns or logs a token except the two
// functions that hand a freshly minted one to the client that earned it.

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

/** RFC 6749 §5.2 error for the token endpoint. */
export type TokenError = {
  ok: false;
  error: "invalid_request" | "invalid_grant" | "invalid_target" | "invalid_client";
  description: string;
};

export type TokenResult = { ok: true; tokens: TokenResponse } | TokenError;

const fail = (error: TokenError["error"], description: string): TokenError => ({
  ok: false,
  error,
  description,
});

// One answer for every way a code or refresh token can be wrong: which
// check failed is nobody's business but the log-free server's.
const BAD_CODE = "The authorization code is invalid, expired, or already used.";
const BAD_REFRESH = "The refresh token is invalid, expired, or revoked.";

function revoke(id: number, now: number): void {
  db.update(agentGrants).set({ revokedAt: now }).where(eq(agentGrants.id, id)).run();
}

/**
 * The owner approved: remember the request and return the one-time code
 * the client will exchange. Pending rows nobody exchanged are swept here.
 */
export function createPendingGrant(input: {
  clientId: string;
  clientName: string;
  scope: string;
  resource: string;
  redirectUri: string;
  codeChallenge: string;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  db.delete(agentGrants)
    .where(
      and(
        isNull(agentGrants.accessTokenHash),
        lt(agentGrants.codeExpiresAt, now - 24 * 60 * 60 * 1000)
      )
    )
    .run();
  const code = randomToken("rc");
  db.insert(agentGrants)
    .values({
      clientId: input.clientId,
      clientName: input.clientName,
      scope: input.scope,
      resource: input.resource,
      codeHash: sha256Hex(code),
      codeExpiresAt: now + AUTH_CODE_TTL_MS,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      createdAt: now,
    })
    .run();
  return code;
}

/** authorization_code grant: the code, bound to its client, redirect and PKCE verifier. */
export function exchangeCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string | null;
  now?: number;
}): TokenResult {
  const now = input.now ?? Date.now();
  const row = db
    .select()
    .from(agentGrants)
    .where(eq(agentGrants.codeHash, sha256Hex(input.code)))
    .get();
  if (!row || row.revokedAt !== null) return fail("invalid_grant", BAD_CODE);
  if (row.accessTokenHash !== null) {
    // A code presented twice (RFC 6749 §4.1.2): someone else has it. The
    // tokens it already bought stop working.
    revoke(row.id, now);
    return fail("invalid_grant", BAD_CODE);
  }
  if (row.codeExpiresAt === null || now > row.codeExpiresAt) {
    revoke(row.id, now);
    return fail("invalid_grant", BAD_CODE);
  }
  if (
    row.clientId !== input.clientId ||
    row.redirectUri !== input.redirectUri ||
    row.codeChallenge === null ||
    !verifyPkceS256(input.codeVerifier, row.codeChallenge)
  ) {
    return fail("invalid_grant", BAD_CODE);
  }
  if (input.resource && !sameResource(input.resource, row.resource)) {
    return fail("invalid_target", "The requested resource is not the one this code was issued for.");
  }

  const accessToken = randomToken("ra");
  const refreshToken = randomToken("rr");
  db.update(agentGrants)
    .set({
      // The code's hash stays as the "already used" marker above; the
      // challenge has done its job.
      codeChallenge: null,
      accessTokenHash: sha256Hex(accessToken),
      accessExpiresAt: now + ACCESS_TOKEN_TTL_MS,
      refreshTokenHash: sha256Hex(refreshToken),
      refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
      lastUsedAt: now,
    })
    .where(eq(agentGrants.id, row.id))
    .run();
  return {
    ok: true,
    tokens: {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: row.scope,
    },
  };
}

/**
 * refresh_token grant. The pair it returns is a keyed function of the
 * token presented (`deriveToken`), which is what lets a repeat inside the
 * grace window be answered with the *same* pair: a lost response, or two
 * workers refreshing at once, converge instead of forking the chain. The
 * replaced token coming back after the window is a replay, and ends the
 * grant.
 */
export function refreshGrant(input: {
  refreshToken: string;
  clientId?: string | null;
  resource?: string | null;
  now?: number;
}): TokenResult {
  const now = input.now ?? Date.now();
  const presented = sha256Hex(input.refreshToken);
  const secret = getSessionSecret();

  const current = db
    .select()
    .from(agentGrants)
    .where(eq(agentGrants.refreshTokenHash, presented))
    .get();
  const row =
    current ??
    db
      .select()
      .from(agentGrants)
      .where(eq(agentGrants.previousRefreshHash, presented))
      .orderBy(desc(agentGrants.id))
      .get();
  if (!row || row.revokedAt !== null) return fail("invalid_grant", BAD_REFRESH);
  if (input.clientId && input.clientId !== row.clientId) return fail("invalid_grant", BAD_REFRESH);
  if (input.resource && !sameResource(input.resource, row.resource)) {
    return fail("invalid_target", "The requested resource is not the one this grant is for.");
  }

  const accessToken = deriveToken(secret, "access", row.id, input.refreshToken);
  const refreshToken = deriveToken(secret, "refresh", row.id, input.refreshToken);

  if (!current) {
    // The token that was just replaced. Its rotation time is the current
    // access token's birth.
    const rotatedAt = (row.accessExpiresAt ?? 0) - ACCESS_TOKEN_TTL_MS;
    const stillCurrent = row.refreshTokenHash === sha256Hex(refreshToken);
    if (!stillCurrent || now - rotatedAt > REFRESH_GRACE_MS || now >= (row.accessExpiresAt ?? 0)) {
      revoke(row.id, now);
      return fail("invalid_grant", BAD_REFRESH);
    }
    return {
      ok: true,
      tokens: {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: Math.max(1, Math.floor(((row.accessExpiresAt ?? now) - now) / 1000)),
        refresh_token: refreshToken,
        scope: row.scope,
      },
    };
  }

  if (row.refreshExpiresAt === null || now > row.refreshExpiresAt) {
    revoke(row.id, now);
    return fail("invalid_grant", BAD_REFRESH);
  }
  db.update(agentGrants)
    .set({
      previousRefreshHash: presented,
      refreshTokenHash: sha256Hex(refreshToken),
      refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
      accessTokenHash: sha256Hex(accessToken),
      accessExpiresAt: now + ACCESS_TOKEN_TTL_MS,
      lastUsedAt: now,
    })
    .where(eq(agentGrants.id, row.id))
    .run();
  return {
    ok: true,
    tokens: {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: row.scope,
    },
  };
}

export type VerifiedAccess = {
  grantId: number;
  clientId: string;
  scopes: string[];
  /** Epoch seconds, as OAuth reports expiry. */
  expiresAt: number;
  resource: string;
};

const LAST_USED_RESOLUTION_MS = 60 * 1000;

/** The grant behind an access token, or null when it opens nothing. */
export function verifyAccessToken(token: string, now = Date.now()): VerifiedAccess | null {
  if (!token) return null;
  const row = db
    .select()
    .from(agentGrants)
    .where(eq(agentGrants.accessTokenHash, sha256Hex(token)))
    .get();
  if (!row || row.revokedAt !== null) return null;
  if (row.accessExpiresAt === null || now >= row.accessExpiresAt) return null;
  // Good enough for "last used 3 minutes ago" without a write per call.
  if (row.lastUsedAt === null || now - row.lastUsedAt > LAST_USED_RESOLUTION_MS) {
    db.update(agentGrants).set({ lastUsedAt: now }).where(eq(agentGrants.id, row.id)).run();
  }
  return {
    grantId: row.id,
    clientId: row.clientId,
    scopes: scopeList(row.scope),
    expiresAt: Math.floor(row.accessExpiresAt / 1000),
    resource: row.resource,
  };
}

export type GrantSummary = {
  id: number;
  clientName: string;
  scope: string;
  resource: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** When the client must have refreshed by, or it is signed out. */
  refreshExpiresAt: number | null;
};

/** Grants that can still act: exchanged, not revoked, refresh not lapsed. */
export function listActiveGrants(now = Date.now()): GrantSummary[] {
  return db
    .select()
    .from(agentGrants)
    .where(and(isNotNull(agentGrants.accessTokenHash), isNull(agentGrants.revokedAt)))
    .orderBy(desc(agentGrants.createdAt))
    .all()
    .filter((g) => g.refreshExpiresAt !== null && g.refreshExpiresAt > now)
    .map((g) => ({
      id: g.id,
      clientName: g.clientName ?? "MCP client",
      scope: g.scope,
      resource: g.resource,
      createdAt: g.createdAt,
      lastUsedAt: g.lastUsedAt,
      refreshExpiresAt: g.refreshExpiresAt,
    }));
}

/** True when a live grant was ended; false when there was nothing to end. */
export function revokeGrant(id: number, now = Date.now()): boolean {
  const row = db
    .select({ id: agentGrants.id, revokedAt: agentGrants.revokedAt })
    .from(agentGrants)
    .where(eq(agentGrants.id, id))
    .get();
  if (!row || row.revokedAt !== null) return false;
  revoke(id, now);
  return true;
}
