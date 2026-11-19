import { describe, expect, it } from "vitest";

import {
  authorizationServerMetadata,
  canonicalResource,
  cleanClientName,
  clientMayRedirectTo,
  deriveAccessToken,
  asksForWrite,
  grantedScope,
  HOSTED_CALLBACKS,
  isAllowedRedirectUri,
  isLoopbackRedirect,
  isValidCodeChallenge,
  mintRefreshToken,
  nextRefreshToken,
  parseClientId,
  protectedResourceMetadata,
  randomToken,
  redirectHost,
  redirectMatches,
  redirectWith,
  refreshTokenGrantId,
  resourceForOrigin,
  sameResource,
  sha256Hex,
  signClientId,
  STATIC_CLIENT_ID,
  validateAuthorizeRequest,
  validateRegistration,
  verifyPkceS256,
} from "@/lib/agent/oauth";

// SPEC §14, Phase 14: the connector's sign-in rules. These are the rules
// that decide who gets a key to the contact book, so each is pinned —
// including the ways a request can be almost right.

const SECRET = "test-secret-0123456789abcdef";
const CLAUDE = HOSTED_CALLBACKS[0];
const ORIGIN = "https://rolo.example.org";
const RESOURCE = `${ORIGIN}/api/mcp`;
// RFC 7636 appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("tokens", () => {
  it("random tokens carry 256 bits, a kind prefix, and never repeat", () => {
    const a = randomToken("ra");
    const b = randomToken("ra");
    expect(a).toMatch(/^ra_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(randomToken("rr").startsWith("rr_")).toBe(true);
    expect(sha256Hex(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(a)).not.toContain(a.slice(3, 20));
  });

  it("a derived access token is a pure function of secret, grant and the token presented", () => {
    const base = deriveAccessToken(SECRET, 7, "rr_old");
    expect(deriveAccessToken(SECRET, 7, "rr_old")).toBe(base);
    expect(base).toMatch(/^ra_[A-Za-z0-9_-]{43}$/);
    for (const other of [
      deriveAccessToken("another-secret", 7, "rr_old"),
      deriveAccessToken(SECRET, 8, "rr_old"),
      deriveAccessToken(SECRET, 7, "rr_older"),
    ]) {
      expect(other).not.toBe(base);
    }
  });
});

describe("refresh tokens name their grant and prove where they came from", () => {
  it("a minted token verifies for its grant, and only under the secret that made it", () => {
    const token = mintRefreshToken(SECRET, 42);
    expect(token).toMatch(/^rr_42\.[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/);
    expect(refreshTokenGrantId(SECRET, token)).toBe(42);
    expect(refreshTokenGrantId("another-secret", token)).toBeNull();
    expect(mintRefreshToken(SECRET, 42)).not.toBe(token);
  });

  it("a successor is the same every time for the same predecessor, and verifies too", () => {
    const first = mintRefreshToken(SECRET, 42);
    const next = nextRefreshToken(SECRET, 42, first);
    expect(nextRefreshToken(SECRET, 42, first)).toBe(next);
    expect(next).not.toBe(first);
    expect(refreshTokenGrantId(SECRET, next)).toBe(42);
    expect(nextRefreshToken(SECRET, 43, first)).not.toBe(next);
    expect(nextRefreshToken(SECRET, 42, next)).not.toBe(next);
  });

  it("nothing forged verifies — a grant id is not a kill switch", () => {
    const token = mintRefreshToken(SECRET, 42);
    const [, nonce, mac] = token.slice(3).split(".");
    for (const forged of [
      `rr_43.${nonce}.${mac}`, // another grant's id on a real signature
      `rr_42.${nonce}x.${mac}`,
      `rr_42.${nonce}.${mac.slice(0, -2)}AA`,
      `rr_42.${nonce}`,
      `rr_42..${mac}`,
      `rr_0.${nonce}.${mac}`,
      `rr_-1.${nonce}.${mac}`,
      `rr_4e1.${nonce}.${mac}`,
      `rr_42.${nonce}.${mac}.extra`,
      `ra_42.${nonce}.${mac}`,
      "rr_42",
      "rr_",
      "",
      "garbage",
      `rr_42.${"a".repeat(400)}.${mac}`,
    ]) {
      expect(refreshTokenGrantId(SECRET, forged), forged.slice(0, 24)).toBeNull();
    }
  });
});

describe("PKCE S256", () => {
  it("accepts the RFC 7636 test vector and nothing near it", () => {
    expect(isValidCodeChallenge(CHALLENGE)).toBe(true);
    expect(verifyPkceS256(VERIFIER, CHALLENGE)).toBe(true);
    expect(verifyPkceS256(`${VERIFIER.slice(0, -1)}X`, CHALLENGE)).toBe(false);
    expect(verifyPkceS256(VERIFIER, `${CHALLENGE.slice(0, -1)}A`)).toBe(false);
    // "plain" would make the challenge its own verifier.
    expect(verifyPkceS256(CHALLENGE, CHALLENGE)).toBe(false);
  });

  it("refuses verifiers outside RFC 7636's length and alphabet", () => {
    expect(verifyPkceS256("short", CHALLENGE)).toBe(false);
    expect(verifyPkceS256("a".repeat(42), CHALLENGE)).toBe(false);
    expect(verifyPkceS256("a".repeat(129), CHALLENGE)).toBe(false);
    expect(verifyPkceS256(`${"a".repeat(42)} `, CHALLENGE)).toBe(false);
    expect(verifyPkceS256("", CHALLENGE)).toBe(false);
  });

  it("a challenge is exactly 43 base64url characters", () => {
    for (const bad of ["", "abc", `${CHALLENGE}=`, `${CHALLENGE}A`, CHALLENGE.replace("-", "+")]) {
      expect(isValidCodeChallenge(bad)).toBe(false);
    }
  });
});

describe("the resource (token audience)", () => {
  it("canonicalises the way Claude sends it", () => {
    expect(canonicalResource("HTTPS://Rolo.Example.ORG:443/api/mcp/#frag")).toBe(RESOURCE);
    expect(canonicalResource("https://rolo.example.org/api/mcp")).toBe(RESOURCE);
    expect(canonicalResource("http://localhost:3000/api/mcp/")).toBe("http://localhost:3000/api/mcp");
    expect(resourceForOrigin(ORIGIN)).toBe(RESOURCE);
  });

  it("refuses what is not a plain http(s) address", () => {
    for (const bad of ["", "not a url", "ftp://rolo.example.org/api/mcp", "https://user:pw@rolo.example.org/api/mcp"]) {
      expect(canonicalResource(bad)).toBeNull();
    }
  });

  it("another host, port or path is another resource", () => {
    expect(sameResource(`${RESOURCE}/`, RESOURCE)).toBe(true);
    expect(sameResource("https://ROLO.example.org/api/mcp", RESOURCE)).toBe(true);
    for (const other of [
      "https://rolo.example.org/api/mcp2",
      "https://rolo.example.org/",
      "https://rolo.example.org:8443/api/mcp",
      "http://rolo.example.org/api/mcp",
      "https://evil.example.org/api/mcp",
      "https://rolo.example.org.evil.test/api/mcp",
      "garbage",
    ]) {
      expect(sameResource(other, RESOURCE)).toBe(false);
    }
  });
});

describe("where a code may be sent", () => {
  it("allows Claude's hosted callback exactly, and loopback on any port", () => {
    for (const ok of [
      ...HOSTED_CALLBACKS,
      "http://localhost:3118/callback",
      "http://localhost/callback",
      "http://127.0.0.1:53124/callback",
      "http://[::1]:9000/oauth/callback",
      "http://localhost:6274/oauth/callback/debug",
    ]) {
      expect(isAllowedRedirectUri(ok), ok).toBe(true);
    }
  });

  it("refuses everything that only looks like them", () => {
    for (const bad of [
      "https://claude.ai/api/mcp/auth_callback/",
      "https://claude.ai/api/mcp/auth_callback?x=1",
      "https://claude.ai/other",
      "http://claude.ai/api/mcp/auth_callback",
      "https://claude.ai.evil.test/api/mcp/auth_callback",
      "https://claude.ai@evil.test/api/mcp/auth_callback",
      "https://evil.test/api/mcp/auth_callback",
      "https://localhost:3000/callback",
      "http://localhost.evil.test/callback",
      "http://127.0.0.1.evil.test/callback",
      "http://evil.test/callback",
      "http://user:pw@localhost:3000/callback",
      "http://localhost:3000/callback#fragment",
      "http://192.168.1.10:3000/callback",
      "http://0.0.0.0:3000/callback",
      "javascript:alert(1)",
      "data:text/html,x",
      "myapp://callback",
      "",
      "not a url",
      `http://localhost:3000/${"a".repeat(400)}`,
    ]) {
      expect(isAllowedRedirectUri(bad), bad).toBe(false);
    }
    expect(isLoopbackRedirect("http://localhost:1/x")).toBe(true);
    expect(isLoopbackRedirect(CLAUDE)).toBe(false);
  });

  it("matches a registered loopback redirect on any port, but not another path or host", () => {
    const registered = ["http://localhost/callback", "http://127.0.0.1/callback", CLAUDE];
    expect(redirectMatches(registered, "http://localhost:3118/callback")).toBe(true);
    expect(redirectMatches(registered, "http://127.0.0.1:1/callback")).toBe(true);
    expect(redirectMatches(registered, CLAUDE)).toBe(true);
    expect(redirectMatches(registered, "http://localhost:3118/other")).toBe(false);
    expect(redirectMatches(registered, "http://localhost:3118/callback?x=1")).toBe(false);
    expect(redirectMatches(registered, "http://[::1]:3118/callback")).toBe(false);
    expect(redirectMatches(registered, HOSTED_CALLBACKS[1])).toBe(false);
    // The hosted callback is never port- or path-flexible.
    expect(redirectMatches([CLAUDE], "https://claude.ai:8443/api/mcp/auth_callback")).toBe(false);
    expect(redirectMatches([], CLAUDE)).toBe(false);
  });

  it("names the host a consent screen should show", () => {
    expect(redirectHost(CLAUDE)).toBe("claude.ai");
    expect(redirectHost("http://localhost:3118/callback")).toBe("localhost:3118");
    expect(redirectHost("nonsense")).toBe("an unreadable address");
  });
});

describe("clients", () => {
  const registration = { redirectUris: [CLAUDE], name: "Claude", issuedAt: 1_800_000_000_000 };

  it("a signed client id round-trips, and is useless under another secret or after tampering", () => {
    const id = signClientId(SECRET, registration);
    expect(parseClientId(SECRET, id)).toEqual({
      clientId: id,
      kind: "dynamic",
      name: "Claude",
      redirectUris: [CLAUDE],
    });
    expect(parseClientId("another-secret", id)).toBeNull();

    const [prefix, payload, mac] = id.split(".");
    const forged = Buffer.from(
      JSON.stringify({ r: ["https://evil.test/cb"], n: "Claude", t: 1 })
    ).toString("base64url");
    expect(parseClientId(SECRET, `${prefix}.${forged}.${mac}`)).toBeNull();
    expect(parseClientId(SECRET, `${prefix}.${payload}.${mac.slice(0, -2)}AA`)).toBeNull();
    expect(parseClientId(SECRET, `${prefix}.${payload}`)).toBeNull();
    expect(parseClientId(SECRET, `x.${payload}.${mac}`)).toBeNull();
  });

  it("refuses ids it did not issue", () => {
    for (const bad of ["", "claude", "dyn..", "dyn.a.b", "dyn.a.b.c", "a".repeat(5000)]) {
      expect(parseClientId(SECRET, bad), bad).toBeNull();
    }
  });

  it("the static client may use any allowed redirect; a registered one only its own", () => {
    const fixed = parseClientId(SECRET, STATIC_CLIENT_ID);
    expect(fixed).toMatchObject({ kind: "static" });
    if (!fixed) throw new Error("static client");
    expect(clientMayRedirectTo(fixed, CLAUDE)).toBe(true);
    expect(clientMayRedirectTo(fixed, "http://localhost:5555/callback")).toBe(true);
    expect(clientMayRedirectTo(fixed, "https://evil.test/cb")).toBe(false);

    const dynamic = parseClientId(SECRET, signClientId(SECRET, registration));
    if (!dynamic) throw new Error("dynamic client");
    expect(clientMayRedirectTo(dynamic, CLAUDE)).toBe(true);
    expect(clientMayRedirectTo(dynamic, "http://localhost:5555/callback")).toBe(false);
  });

  it("a signature cannot smuggle in a redirect the policy forbids", () => {
    // Even a correctly signed id (say, minted by an older, laxer version)
    // is checked against the policy at use.
    const lax = parseClientId(
      SECRET,
      signClientId(SECRET, { redirectUris: ["https://evil.test/cb"], name: "x", issuedAt: 1 })
    );
    if (!lax) throw new Error("lax client");
    expect(clientMayRedirectTo(lax, "https://evil.test/cb")).toBe(false);
  });

  it("cleans a client-supplied name down to something safe to show", () => {
    expect(cleanClientName("  Claude  ")).toBe("Claude");
    expect(cleanClientName("Cl\u0000au\u202Ede\u200B")).toBe("Claude");
    expect(cleanClientName("a".repeat(500))).toHaveLength(80);
    expect(cleanClientName("")).toBe("MCP client");
    expect(cleanClientName("\u200B\u200B")).toBe("MCP client");
    expect(cleanClientName(42)).toBe("MCP client");
    expect(cleanClientName(undefined)).toBe("MCP client");
  });
});

describe("validateRegistration (RFC 7591)", () => {
  it("accepts Claude's registration and keeps only what matters", () => {
    expect(
      validateRegistration({
        client_name: "Claude",
        redirect_uris: [CLAUDE, CLAUDE],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
        scope: "read write",
        anything_else: { nested: true },
      })
    ).toEqual({ ok: true, redirectUris: [CLAUDE], name: "Claude" });
    expect(validateRegistration({ redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"] })).toEqual({
      ok: true,
      redirectUris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      name: "MCP client",
    });
  });

  it("refuses a registration that names anywhere else, or nothing", () => {
    for (const body of [
      { redirect_uris: ["https://evil.test/cb"] },
      { redirect_uris: [CLAUDE, "https://evil.test/cb"] },
      { redirect_uris: [] },
      { redirect_uris: "http://localhost/callback" },
      { redirect_uris: [42] },
      { redirect_uris: Array.from({ length: 11 }, (_, i) => `http://localhost:${3000 + i}/cb`) },
      // Individually allowed, together too long to carry in a client id.
      { redirect_uris: Array.from({ length: 5 }, (_, i) => `http://localhost:${3000 + i}/${"a".repeat(360)}`) },
      {},
    ]) {
      expect(validateRegistration(body)).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    }
    for (const body of [null, "text", 42, [CLAUDE]]) {
      expect(validateRegistration(body)).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    }
  });
});

describe("a registration always fits in the id that carries it", () => {
  it("the largest registration Rolo accepts yields an id it can read back", () => {
    const uris = Array.from({ length: 4 }, (_, i) => `http://localhost:${3000 + i}/${"a".repeat(340)}`);
    const reg = validateRegistration({ redirect_uris: uris, client_name: "n".repeat(500) });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    const id = signClientId(SECRET, { redirectUris: reg.redirectUris, name: reg.name, issuedAt: Date.now() });
    expect(id.length).toBeLessThan(4000);
    expect(parseClientId(SECRET, id)).toMatchObject({ kind: "dynamic", redirectUris: uris });
  });
});

describe("scopes", () => {
  it("grants read whatever was asked for, and write only when asked", () => {
    expect(grantedScope(undefined)).toBe("read");
    expect(grantedScope("")).toBe("read");
    expect(grantedScope("read")).toBe("read");
    expect(grantedScope("read offline_access")).toBe("read");
    expect(grantedScope("offline_access")).toBe("read");
    expect(grantedScope("read write")).toBe("read write");
    // Write never comes without read, and nothing Rolo does not know is honoured.
    expect(grantedScope("write")).toBe("read write");
    expect(grantedScope("read write admin delete")).toBe("read write");
    expect(grantedScope("WRITE")).toBe("read");
    expect(grantedScope("readwrite")).toBe("read");
  });

  it("the owner's tick is the last word on write", () => {
    expect(grantedScope("read write", { allowWrite: false })).toBe("read");
    expect(grantedScope("read write", { allowWrite: true })).toBe("read write");
    // A tick cannot grant what was not asked for.
    expect(grantedScope("read", { allowWrite: true })).toBe("read");
    expect(asksForWrite("read write")).toBe(true);
    expect(asksForWrite("read")).toBe(false);
    expect(asksForWrite(null)).toBe(false);
  });
});

describe("validateAuthorizeRequest", () => {
  const clientId = signClientId(SECRET, { redirectUris: [CLAUDE], name: "Claude", issuedAt: 1 });
  const good = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "xyz",
    scope: "read offline_access",
    resource: RESOURCE,
  };
  const ctx = { secret: SECRET, resource: RESOURCE };

  it("accepts a well-formed request", () => {
    const res = validateAuthorizeRequest(good, ctx);
    expect(res).toMatchObject({
      ok: true,
      request: { redirectUri: CLAUDE, codeChallenge: CHALLENGE, state: "xyz", scope: "read", resource: RESOURCE },
    });
    // No state, no scope, no resource: still fine, with defaults.
    expect(
      validateAuthorizeRequest({ ...good, state: null, scope: null, resource: null }, ctx)
    ).toMatchObject({ ok: true, request: { state: null, scope: "read", resource: RESOURCE } });
    expect(validateAuthorizeRequest({ ...good, resource: `${RESOURCE}/` }, ctx).ok).toBe(true);
    expect(validateAuthorizeRequest({ ...good, client_id: STATIC_CLIENT_ID }, ctx).ok).toBe(true);
  });

  it("never offers a redirect when the client or the redirect is not trustworthy", () => {
    for (const params of [
      { ...good, client_id: null },
      { ...good, client_id: "unknown" },
      { ...good, client_id: signClientId("another-secret", { redirectUris: [CLAUDE], name: "x", issuedAt: 1 }) },
      { ...good, redirect_uri: null },
      { ...good, redirect_uri: "https://evil.test/cb" },
      { ...good, redirect_uri: "http://localhost:3000/callback" }, // not what this client registered
      { ...good, state: "s".repeat(2001) },
    ]) {
      expect(validateAuthorizeRequest(params, ctx)).toMatchObject({ ok: false, redirect: false });
    }
  });

  it("sends protocol errors back to a redirect it trusts, with the state", () => {
    const cases: [Record<string, string | null>, string][] = [
      [{ ...good, response_type: "token" }, "unsupported_response_type"],
      [{ ...good, response_type: null }, "unsupported_response_type"],
      [{ ...good, code_challenge: null }, "invalid_request"],
      [{ ...good, code_challenge_method: "plain" }, "invalid_request"],
      [{ ...good, code_challenge_method: null }, "invalid_request"],
      [{ ...good, code_challenge: "too-short" }, "invalid_request"],
      [{ ...good, resource: "https://another.example.org/api/mcp" }, "invalid_target"],
      [{ ...good, resource: "nonsense" }, "invalid_target"],
    ];
    for (const [params, error] of cases) {
      expect(validateAuthorizeRequest(params, ctx)).toMatchObject({
        ok: false,
        redirect: true,
        redirectUri: CLAUDE,
        state: "xyz",
        error,
      });
    }
  });
});

describe("redirectWith", () => {
  it("appends the answer, keeps what was there, and encodes", () => {
    expect(redirectWith(CLAUDE, { code: "a b&c", state: "s/1", iss: null, extra: undefined })).toBe(
      `${CLAUDE}?code=a+b%26c&state=s%2F1`
    );
    expect(redirectWith("http://localhost:3118/callback?keep=1", { code: "x" })).toBe(
      "http://localhost:3118/callback?keep=1&code=x"
    );
  });
});

describe("discovery documents", () => {
  it("say what Claude's client needs to read", () => {
    expect(protectedResourceMetadata(ORIGIN)).toEqual({
      resource: RESOURCE,
      authorization_servers: [ORIGIN],
      scopes_supported: ["read", "write"],
      bearer_methods_supported: ["header"],
      resource_name: "Rolo",
    });
    const as = authorizationServerMetadata(ORIGIN);
    expect(as).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/api/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
    });
    // Not advertised, so Claude registers dynamically instead of asking
    // Rolo to fetch a metadata document from the internet.
    expect(as).not.toHaveProperty("client_id_metadata_document_supported");
  });
});
