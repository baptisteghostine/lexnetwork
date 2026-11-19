import crypto from "node:crypto";

import { expect, test, type APIRequestContext } from "playwright/test";

import { E2E_PASSWORD } from "./helpers";

// SPEC §14, Phase 14: the agent connector over real HTTP and a real
// browser — discovery, registration, the consent screen, the token
// exchange, an MCP conversation, the Settings card, and disconnecting.
// What the unit tests cannot show: that Next serves the /.well-known
// routes, that the consent form's redirect leaves the app, and that the
// whole chain works through the framework rather than around it.

test.describe.configure({ mode: "serial" });

const CALLBACK = "http://localhost:59999/callback";
const ORIGIN = "http://localhost:3100";
const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

const shared: { clientId: string; accessToken: string; refreshToken: string } = {
  clientId: "",
  accessToken: "",
  refreshToken: "",
};

function authorizeUrl(over: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: shared.clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "e2e-state",
    scope: "read",
    resource: `${ORIGIN}/api/mcp`,
    ...over,
  });
  return `/oauth/authorize?${params.toString()}`;
}

async function mcp(request: APIRequestContext, token: string | null, body: unknown) {
  const res = await request.post("/api/mcp", {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    data: body,
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  let message: Record<string, unknown> | null = null;
  try {
    message = JSON.parse(line ? line.slice(6) : text) as Record<string, unknown>;
  } catch {
    message = null;
  }
  return { res, message };
}

test("discovery documents are served, and the endpoint asks for sign-in", async ({ request }) => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(await res.json()).toMatchObject({
      resource: `${ORIGIN}/api/mcp`,
      authorization_servers: [ORIGIN],
    });
  }
  const as = await request.get("/.well-known/oauth-authorization-server");
  expect(as.status()).toBe(200);
  expect(await as.json()).toMatchObject({
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/oauth/authorize`,
    token_endpoint: `${ORIGIN}/api/oauth/token`,
    registration_endpoint: `${ORIGIN}/api/oauth/register`,
    code_challenge_methods_supported: ["S256"],
  });

  const anonymous = await mcp(request, null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(anonymous.res.status()).toBe(401);
  expect(anonymous.res.headers()["www-authenticate"]).toContain(
    `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`
  );
});

test("a client registers itself without anything being stored", async ({ request }) => {
  const res = await request.post("/api/oauth/register", {
    data: { client_name: "E2E client", redirect_uris: [CALLBACK] },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { client_id: string };
  expect(body.client_id).toMatch(/^dyn\./);
  shared.clientId = body.client_id;

  const refused = await request.post("/api/oauth/register", {
    data: { client_name: "Evil", redirect_uris: ["https://evil.example.invalid/cb"] },
  });
  expect(refused.status()).toBe(400);
});

test("a request Rolo cannot trust is shown as an error and goes nowhere", async ({ page }) => {
  await page.goto(authorizeUrl({ client_id: "dyn.forged.forged" }));
  await expect(page.getByText("This connection request can't be used.")).toBeVisible();
  await expect(page.getByLabel("Your Rolo password")).toHaveCount(0);

  await page.goto(authorizeUrl({ redirect_uri: "https://evil.example.invalid/cb" }));
  await expect(page.getByText("This connection request can't be used.")).toBeVisible();
});

test("Deny returns to the app with access_denied", async ({ page }) => {
  let denied: URL | null = null;
  await page.route("http://localhost:59999/**", async (route) => {
    denied = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/plain", body: "denied" });
  });
  await page.goto(authorizeUrl());
  await page.getByRole("link", { name: "Deny" }).click();
  await expect.poll(() => denied?.searchParams.get("error")).toBe("access_denied");
  expect(denied!.searchParams.get("state")).toBe("e2e-state");
  expect(denied!.searchParams.get("code")).toBeNull();
});

test("the consent screen says who is asking and where the answer goes; the password approves", async ({
  page,
  request,
}) => {
  let callback: URL | null = null;
  await page.route("http://localhost:59999/**", async (route) => {
    callback = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/plain", body: "connected" });
  });

  const response = await page.goto(authorizeUrl());
  // The page that asks for the password can never be framed by another site.
  expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
  await expect(page.getByText("Connect to your Rolo?")).toBeVisible();
  await expect(page.getByText(/Only allow this if you started it yourself/)).toBeVisible();
  await expect(page.getByText("“E2E client”")).toBeVisible();
  await expect(page.getByText("localhost:59999")).toBeVisible();
  await expect(page.getByText("That is a program on this computer.")).toBeVisible();
  await expect(page.getByText("Change, add or delete anything.")).toBeVisible();

  // A wrong password stays on the page and sends nothing.
  await page.getByLabel("Your Rolo password").fill("definitely-not-it");
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByText("Wrong password.")).toBeVisible();
  expect(callback).toBeNull();

  await page.getByLabel("Your Rolo password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => callback?.searchParams.get("code") ?? null).not.toBeNull();
  const url = callback!;
  expect(url.searchParams.get("state")).toBe("e2e-state");
  expect(url.searchParams.get("iss")).toBe(ORIGIN);

  // The wrong verifier buys nothing; the right one buys the tokens.
  const form = {
    grant_type: "authorization_code",
    code: url.searchParams.get("code")!,
    client_id: shared.clientId,
    redirect_uri: CALLBACK,
    resource: `${ORIGIN}/api/mcp`,
  };
  const bad = await request.post("/api/oauth/token", { form: { ...form, code_verifier: "x".repeat(43) } });
  expect(bad.status()).toBe(400);
  expect(await bad.json()).toMatchObject({ error: "invalid_grant" });
  const good = await request.post("/api/oauth/token", { form: { ...form, code_verifier: verifier } });
  expect(good.status()).toBe(200);
  const tokens = (await good.json()) as { access_token: string; refresh_token: string; scope: string };
  expect(tokens.scope).toBe("read");
  shared.accessToken = tokens.access_token;
  shared.refreshToken = tokens.refresh_token;
});

test("Claude's handshake, the tool list and a real search work over HTTP", async ({ request }) => {
  const init = await mcp(request, shared.accessToken, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
  });
  expect(init.res.status()).toBe(200);
  expect(init.message).toMatchObject({ result: { serverInfo: { name: "rolo" } } });

  const list = await mcp(request, shared.accessToken, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect((list.message!.result as { tools: unknown[] }).tools).toHaveLength(9);

  // "Zara Quicklog" was created by the quick-log spec earlier in this run.
  const search = await mcp(request, shared.accessToken, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "search_contacts", arguments: { query: "Zara" } },
  });
  const result = search.message!.result as { isError: boolean; content: { text: string }[] };
  expect(result.isError).toBe(false);
  const data = JSON.parse(result.content[0].text) as { total: number; contacts: { id: number; name: string }[] };
  expect(data.contacts.map((c) => c.name)).toContain("Zara Quicklog");

  const profile = await mcp(request, shared.accessToken, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "get_contacts", arguments: { ids: [data.contacts[0].id] } },
  });
  const full = JSON.parse((profile.message!.result as { content: { text: string }[] }).content[0].text) as {
    contacts: { name: string; interactions: { title: string }[] }[];
  };
  expect(full.contacts[0].interactions.map((i) => i.title)).toContain("Met at demo day");
});

test("a refresh rotates the tokens", async ({ request }) => {
  const res = await request.post("/api/oauth/token", {
    form: { grant_type: "refresh_token", refresh_token: shared.refreshToken, client_id: shared.clientId },
  });
  expect(res.status()).toBe(200);
  const next = (await res.json()) as { access_token: string; refresh_token: string };
  expect(next.access_token).not.toBe(shared.accessToken);
  const old = await mcp(request, shared.accessToken, { jsonrpc: "2.0", id: 5, method: "tools/list" });
  expect(old.res.status()).toBe(401);
  shared.accessToken = next.access_token;
  shared.refreshToken = next.refresh_token;
  const fresh = await mcp(request, shared.accessToken, { jsonrpc: "2.0", id: 6, method: "tools/list" });
  expect(fresh.res.status()).toBe(200);
});

test("Settings shows the connection and its activity, and Disconnect shuts it out", async ({
  page,
  request,
}) => {
  await page.goto("/settings?tab=connector");
  await expect(page.getByRole("heading", { name: "Claude connector" })).toBeVisible();
  await expect(page.getByText(`${ORIGIN}/api/mcp`)).toBeVisible();
  // The test server is plain http: the card says Claude will not use it.
  await expect(page.getByText("This address is not HTTPS.")).toBeVisible();
  await expect(page.getByText("E2E client")).toBeVisible();
  await expect(page.getByText(/Read-only · connected/)).toBeVisible();
  await expect(page.getByText(/Searched contacts — "Zara"/)).toBeVisible();
  await expect(page.getByText("Read Zara Quicklog's profile")).toBeVisible();

  await page.getByRole("button", { name: "Disconnect" }).click();
  // A second, deliberate click: this cannot be undone from Claude's side.
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("Nothing is connected.")).toBeVisible();

  const after = await mcp(request, shared.accessToken, { jsonrpc: "2.0", id: 7, method: "tools/list" });
  expect(after.res.status()).toBe(401);
  const refresh = await request.post("/api/oauth/token", {
    form: { grant_type: "refresh_token", refresh_token: shared.refreshToken },
  });
  expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
});
