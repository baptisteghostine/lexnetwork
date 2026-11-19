import "server-only";

import {
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server";

import { getSessionSecret } from "@/lib/auth/secret";
import {
  authorizationServerMetadata,
  MCP_PATH,
  parseClientId,
  protectedResourceMetadata,
  resourceForOrigin,
  signClientId,
  validateRegistration,
} from "@/lib/agent/oauth";
import { exchangeCode, refreshGrant, verifyAccessToken, type TokenResult } from "@/server/agent/grants";
import { agentMcpHandler } from "@/server/agent/mcp";
import { publicOrigin } from "@/server/sync/request-origin";

// The connector's HTTP surface (SPEC §14, Phase 14). Route files under
// src/app are one-line re-exports of these, so the logic is typed, linted
// and tested in one place — including the two routes that live in a
// dot-directory (/.well-known), which tooling tends to skip.
//
// Nothing here uses the session cookie. The MCP endpoint is opened by a
// bearer token; the OAuth endpoints are public by nature and give nothing
// away: discovery documents, a registration that stores nothing, and a
// token exchange that needs a code only the owner's password can mint.

// These endpoints are called by Claude's servers and by local tools
// (Claude Code, an inspector running on localhost); none of them relies on
// cookies, so a permissive CORS policy exposes nothing a direct request
// would not.
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  // Authorization has to be named (a wildcard never covers it); the rest
  // are the MCP transport's headers, with a wildcard for the ones a later
  // protocol revision adds.
  "access-control-allow-headers":
    "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, last-event-id, *",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
  "access-control-max-age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Tokens and discovery answers are never to be cached by anything.
      "cache-control": "no-store",
      pragma: "no-cache",
      ...CORS,
      ...extra,
    },
  });
}

/**
 * Read a request body as text, refusing anything over `maxBytes` — by its
 * declared length when there is one, and by counting as it streams in
 * either case. These endpoints answer anyone, so nothing they are sent may
 * be buffered whole before it is known to be small. Null = too large.
 */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

// ---------- discovery ----------

export function protectedResourceResponse(req: Request): Response {
  return json(protectedResourceMetadata(publicOrigin(req)));
}

export function authorizationServerResponse(req: Request): Response {
  return json(authorizationServerMetadata(publicOrigin(req)));
}

// ---------- the MCP endpoint ----------

/**
 * Browsers attach an Origin; Claude's servers and command-line clients do
 * not. A browser page may only reach the endpoint from the app's own
 * host, Claude's, or the owner's own machine (matched by hostname).
 * Defence in depth, not the lock: the lock is the bearer token, which no
 * browser attaches by itself, so there is no ambient credential for
 * another site to ride on.
 */
function allowedOriginHosts(publicHost: string): string[] {
  return [publicHost, "claude.ai", "claude.com", "localhost", "127.0.0.1", "[::1]"];
}

export async function handleMcp(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return preflight();
  const origin = publicOrigin(req);
  const rejected = originValidationResponse(req, allowedOriginHosts(new URL(origin).hostname));
  if (rejected) return withCors(rejected);

  const resource = resourceForOrigin(origin);
  const gate = requireBearerAuth({
    verifier: {
      async verifyAccessToken(token) {
        const grant = verifyAccessToken(token);
        if (!grant) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, "The access token is invalid, expired or revoked.");
        }
        return {
          token,
          clientId: grant.clientId,
          scopes: grant.scopes,
          expiresAt: grant.expiresAt,
          resource: new URL(grant.resource),
          extra: { grantId: grant.grantId },
        };
      },
    },
    // A token minted for another address — a previous domain, another
    // server — is not a token for this one (RFC 8707).
    expectedResource: new URL(resource),
    // Where an unauthenticated client learns how to sign in (RFC 9728);
    // Claude starts its sign-in from this 401.
    resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`,
  });
  const auth = await gate(req);
  if (auth instanceof Response) return withCors(auth);
  return withCors(await agentMcpHandler().fetch(req, { authInfo: auth }));
}

// ---------- dynamic client registration (RFC 7591) ----------

const REGISTRATION_BODY_MAX = 20_000;

export async function handleRegister(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return preflight();
  const raw = await readBodyLimited(req, REGISTRATION_BODY_MAX);
  if (raw === null) {
    return json({ error: "invalid_client_metadata", error_description: "The registration is too large." }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_client_metadata", error_description: "The body must be JSON." }, 400);
  }
  const reg = validateRegistration(body);
  if (!reg.ok) return json({ error: reg.error, error_description: reg.description }, 400);
  const issuedAt = Date.now();
  return json(
    {
      // The id carries the registration, signed: nothing is stored.
      client_id: signClientId(getSessionSecret(), {
        redirectUris: reg.redirectUris,
        name: reg.name,
        issuedAt,
      }),
      client_id_issued_at: Math.floor(issuedAt / 1000),
      client_name: reg.name,
      redirect_uris: reg.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201
  );
}

// ---------- the token endpoint ----------

const TOKEN_BODY_MAX = 20_000;

function tokenError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

function tokenResponse(result: TokenResult): Response {
  if (!result.ok) return tokenError(result.error, result.description);
  return json(result.tokens);
}

export async function handleToken(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return preflight();
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return tokenError("invalid_request", "Send the request as application/x-www-form-urlencoded.");
  }
  const raw = await readBodyLimited(req, TOKEN_BODY_MAX);
  if (raw === null) return tokenError("invalid_request", "The request is too large.", 413);
  const form = new URLSearchParams(raw);
  const field = (name: string): string | null => {
    const values = form.getAll(name);
    // RFC 6749 §3.2: a parameter must not appear more than once.
    return values.length === 1 && values[0] !== "" ? values[0] : null;
  };
  for (const name of new Set(form.keys())) {
    if (form.getAll(name).length > 1) {
      return tokenError("invalid_request", `The parameter ${name.slice(0, 40)} appears more than once.`);
    }
  }

  const clientId = field("client_id");
  if (clientId !== null && !parseClientId(getSessionSecret(), clientId)) {
    return tokenError("invalid_client", "Unknown client.", 401);
  }
  const grantType = field("grant_type");

  if (grantType === "authorization_code") {
    const code = field("code");
    const codeVerifier = field("code_verifier");
    const redirectUri = field("redirect_uri");
    if (!code || !codeVerifier || !redirectUri || !clientId) {
      return tokenError(
        "invalid_request",
        "authorization_code needs code, code_verifier, redirect_uri and client_id."
      );
    }
    return tokenResponse(
      exchangeCode({ code, codeVerifier, redirectUri, clientId, resource: field("resource") })
    );
  }
  if (grantType === "refresh_token") {
    const refreshToken = field("refresh_token");
    if (!refreshToken) return tokenError("invalid_request", "refresh_token is required.");
    return tokenResponse(refreshGrant({ refreshToken, clientId, resource: field("resource") }));
  }
  return tokenError(
    "unsupported_grant_type",
    "Only authorization_code and refresh_token are supported."
  );
}
