// The agent connector's sign-in rules (SPEC §14, Phase 14). Pure: no
// database, no request objects — the routes and the grant store call into
// here, and the unit tests pin every rule.
//
// Rolo is its own OAuth 2.1 authorization server for exactly one person.
// The shape follows what Claude's connector client requires: a public
// client, PKCE S256 on every request, tokens bound to the connector's URL
// (the RFC 8707 "resource"), rotating refresh tokens.

import crypto from "node:crypto";

/** Where the MCP endpoint lives; with the origin it is the resource. */
export const MCP_PATH = "/api/mcp";
export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/api/oauth/token";
export const REGISTER_PATH = "/api/oauth/register";

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Sliding: every refresh starts it again, so only 90 idle days end a grant. */
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
/**
 * How long the refresh token that was just replaced still answers — with
 * the same new pair, not another one. A lost response or two workers
 * refreshing at once is ordinary; after this window the old token coming
 * back means it was copied, and the grant is revoked.
 */
export const REFRESH_GRACE_MS = 60 * 1000;

/** What a grant may carry. Phase 15 adds "write". */
export const GRANTABLE_SCOPES = ["read"] as const;
export type Scope = (typeof GRANTABLE_SCOPES)[number];

/** For "use your own OAuth client" in Claude's dialog — nothing to register. */
export const STATIC_CLIENT_ID = "rolo-connector";

/**
 * The only places an authorization code may be sent. A code is a key to
 * the whole contact book, so the redirect is not left to whoever registers
 * a client: Claude's hosted callback, or a loopback address on the
 * owner's own machine (Claude Code, a local inspector).
 */
export const HOSTED_CALLBACKS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// ---------- tokens ----------

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** 256 random bits, URL-safe, with a prefix that says what it is. */
export function randomToken(prefix: "ra" | "rr" | "rc"): string {
  return `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
}

/**
 * The token a refresh produces, as a keyed function of the refresh token
 * that was presented. Deterministic on purpose: a retry of the same
 * refresh inside the grace window gets the same pair back without the
 * server ever storing a token in clear.
 */
export function deriveToken(
  secret: string,
  kind: "access" | "refresh",
  grantId: number,
  presentedRefreshToken: string
): string {
  const mac = crypto
    .createHmac("sha256", secret)
    .update(`rolo-connector:${kind}:${grantId}:${presentedRefreshToken}`)
    .digest("base64url");
  return `${kind === "access" ? "ra" : "rr"}_${mac}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- PKCE ----------

/** A S256 challenge is the base64url of a SHA-256: exactly 43 characters. */
export function isValidCodeChallenge(challenge: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(challenge);
}

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  // RFC 7636 §4.1: 43–128 characters from the unreserved set.
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = crypto.createHash("sha256").update(verifier).digest("base64url");
  return safeEqual(computed, challenge);
}

// ---------- the resource (audience) ----------

/**
 * Canonical form of a resource URL, as Claude sends it: lowercase scheme
 * and host, no default port, no fragment, no trailing slash. Null when it
 * is not an http(s) URL.
 */
export function canonicalResource(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, "");
  // URL already lowercases scheme and host and drops a default port.
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/** The connector's resource identifier for a public origin. */
export function resourceForOrigin(origin: string): string {
  return canonicalResource(`${origin}${MCP_PATH}`) ?? `${origin}${MCP_PATH}`;
}

export function sameResource(a: string, b: string): boolean {
  const x = canonicalResource(a);
  const y = canonicalResource(b);
  return x !== null && x === y;
}

// ---------- redirect URIs ----------

function parseRedirect(uri: string): URL | null {
  if (uri.length > 400) return null;
  try {
    const url = new URL(uri);
    // A fragment would carry the code out of the query; credentials have
    // no business in a redirect.
    if (url.hash || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function isLoopbackRedirect(uri: string): boolean {
  const url = parseRedirect(uri);
  return url !== null && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/** May a code ever be sent here, whoever the client is? */
export function isAllowedRedirectUri(uri: string): boolean {
  if (parseRedirect(uri) === null) return false;
  return (HOSTED_CALLBACKS as readonly string[]).includes(uri) || isLoopbackRedirect(uri);
}

/**
 * Does the redirect on a request match one the client registered? Exact
 * for the hosted callback; for loopback the port is ignored (RFC 8252
 * §7.3 — a native client listens on whatever port is free), for
 * `localhost` as well as the IP literals because Claude Code uses it.
 */
export function redirectMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  const want = parseRedirect(presented);
  if (!want || !isLoopbackRedirect(presented)) return false;
  return registered.some((r) => {
    if (!isLoopbackRedirect(r)) return false;
    const have = parseRedirect(r);
    return (
      have !== null &&
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}

/** What the consent screen shows: where the code is about to go. */
export function redirectHost(uri: string): string {
  return parseRedirect(uri)?.host ?? "an unreadable address";
}

// ---------- clients ----------
//
// Claude registers itself dynamically (RFC 7591), a new client on every
// fresh connection. Rather than keep a table that only ever grows, the
// client id *is* the registration: the registered redirect URIs and name,
// signed with the server's secret. Nothing is stored, anyone may ask for
// one, and holding one grants nothing — the owner's password does.

export type ClientInfo = {
  clientId: string;
  kind: "static" | "dynamic";
  name: string;
  /** Empty for the static client: it may use any allowed redirect. */
  redirectUris: string[];
};

const CLIENT_NAME_MAX = 80;
const DEFAULT_CLIENT_NAME = "MCP client";

/** Control characters, zero-width marks and bidi overrides: nothing a name needs. */
function isInvisible(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202f) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** A name supplied by the client: shown to the owner, so plain and short. */
export function cleanClientName(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_CLIENT_NAME;
  const name = Array.from(raw)
    .filter((ch) => !isInvisible(ch.codePointAt(0) ?? 0))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CLIENT_NAME_MAX);
  return name || DEFAULT_CLIENT_NAME;
}

function clientMac(secret: string, payload: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`rolo-connector:client:${payload}`)
    .digest("base64url");
}

export function signClientId(
  secret: string,
  registration: { redirectUris: string[]; name: string; issuedAt: number }
): string {
  const payload = Buffer.from(
    JSON.stringify({ r: registration.redirectUris, n: registration.name, t: registration.issuedAt })
  ).toString("base64url");
  return `dyn.${payload}.${clientMac(secret, payload)}`;
}

/** The client behind an id, or null when the id is not one Rolo issued. */
export function parseClientId(secret: string, clientId: string): ClientInfo | null {
  if (clientId === STATIC_CLIENT_ID) {
    return { clientId, kind: "static", name: "Claude", redirectUris: [] };
  }
  if (clientId.length > 4000) return null;
  const parts = clientId.split(".");
  if (parts.length !== 3 || parts[0] !== "dyn") return null;
  const [, payload, mac] = parts;
  if (!safeEqual(mac, clientMac(secret, payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      r?: unknown;
      n?: unknown;
    };
    if (!Array.isArray(data.r) || !data.r.every((u) => typeof u === "string")) return null;
    return {
      clientId,
      kind: "dynamic",
      name: cleanClientName(data.n),
      redirectUris: data.r as string[],
    };
  } catch {
    return null;
  }
}

/** May this client have its code sent to this redirect? */
export function clientMayRedirectTo(client: ClientInfo, redirectUri: string): boolean {
  if (!isAllowedRedirectUri(redirectUri)) return false;
  return client.kind === "static" ? true : redirectMatches(client.redirectUris, redirectUri);
}

export type RegistrationResult =
  | { ok: true; redirectUris: string[]; name: string }
  | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

/** RFC 7591 registration request → what Rolo will sign, or why not. */
export function validateRegistration(body: unknown): RegistrationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "invalid_client_metadata", description: "The body must be a JSON object." };
  }
  const uris = (body as { redirect_uris?: unknown }).redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
    return { ok: false, error: "invalid_redirect_uri", description: "redirect_uris must list between 1 and 10 addresses." };
  }
  const redirectUris: string[] = [];
  for (const uri of uris) {
    if (typeof uri !== "string" || !isAllowedRedirectUri(uri)) {
      return {
        ok: false,
        error: "invalid_redirect_uri",
        description:
          "Each redirect must be Claude's callback or an http loopback address (localhost, 127.0.0.1, [::1]).",
      };
    }
    if (!redirectUris.includes(uri)) redirectUris.push(uri);
  }
  return {
    ok: true,
    redirectUris,
    name: cleanClientName((body as { client_name?: unknown }).client_name),
  };
}

// ---------- scopes ----------

/**
 * The scope a grant gets for what was asked. Anything Rolo does not grant
 * is dropped rather than refused (Claude appends `offline_access`, and a
 * later client may ask for `write` before this version has it); asking
 * for nothing gets the default. The token response always says what was
 * actually granted.
 */
export function grantedScope(requested: string | null | undefined): string {
  const asked = (requested ?? "").split(/\s+/).filter(Boolean);
  const granted = GRANTABLE_SCOPES.filter((s) => asked.includes(s));
  return (granted.length > 0 ? granted : ["read"]).join(" ");
}

export function scopeList(scope: string): string[] {
  return scope.split(/\s+/).filter(Boolean);
}

// ---------- the authorization request ----------

export type AuthorizeParams = {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  state?: string | null;
  scope?: string | null;
  resource?: string | null;
};

export type AuthorizeRequest = {
  client: ClientInfo;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string;
  resource: string;
};

export type AuthorizeValidation =
  | { ok: true; request: AuthorizeRequest }
  /** The client or redirect cannot be trusted: say so on the page, never redirect. */
  | { ok: false; redirect: false; description: string }
  /** The redirect is good, the request is not: the error goes back to the client. */
  | { ok: false; redirect: true; redirectUri: string; state: string | null; error: string; description: string };

const STATE_MAX = 2000;

export function validateAuthorizeRequest(
  params: AuthorizeParams,
  ctx: { secret: string; resource: string }
): AuthorizeValidation {
  const client = params.client_id ? parseClientId(ctx.secret, params.client_id) : null;
  if (!client) {
    return { ok: false, redirect: false, description: "This sign-in request names an app Rolo does not recognise." };
  }
  const redirectUri = params.redirect_uri ?? "";
  if (!redirectUri || !clientMayRedirectTo(client, redirectUri)) {
    return {
      ok: false,
      redirect: false,
      description: "This sign-in request would send the result to an address that is not allowed.",
    };
  }
  const state = params.state ?? null;
  if (state !== null && state.length > STATE_MAX) {
    return { ok: false, redirect: false, description: "This sign-in request is malformed." };
  }
  const refuse = (error: string, description: string): AuthorizeValidation => ({
    ok: false,
    redirect: true,
    redirectUri,
    state,
    error,
    description,
  });
  if (params.response_type !== "code") {
    return refuse("unsupported_response_type", "Only response_type=code is supported.");
  }
  if (params.code_challenge_method !== "S256" || !params.code_challenge) {
    return refuse("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  if (!isValidCodeChallenge(params.code_challenge)) {
    return refuse("invalid_request", "code_challenge is not a valid S256 challenge.");
  }
  // RFC 8707: a token is for one resource. A request naming another one is
  // refused; one naming none is taken to mean this connector.
  if (params.resource && !sameResource(params.resource, ctx.resource)) {
    return refuse("invalid_target", "The requested resource is not this connector.");
  }
  return {
    ok: true,
    request: {
      client,
      redirectUri,
      codeChallenge: params.code_challenge,
      state,
      scope: grantedScope(params.scope),
      resource: ctx.resource,
    },
  };
}

/** `redirectUri` with the answer's parameters appended to its query. */
export function redirectWith(
  redirectUri: string,
  params: Record<string, string | null | undefined>
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

// ---------- discovery documents ----------

export function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceForOrigin(origin),
    authorization_servers: [origin],
    scopes_supported: [...GRANTABLE_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Rolo",
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${TOKEN_PATH}`,
    registration_endpoint: `${origin}${REGISTER_PATH}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    // A public client: no secret to keep, PKCE instead.
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...GRANTABLE_SCOPES],
    authorization_response_iss_parameter_supported: true,
  };
}
