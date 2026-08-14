import { describe, expect, it } from "vitest";

import {
  isAllowedOutboundUrl,
  outboundFetch,
  OutboundBlockedError,
} from "../../../src/lib/net/fetch";

describe("outbound host allowlist (CLAUDE.md privacy invariant)", () => {
  it("allows the configured integration hosts over https", () => {
    for (const url of [
      "https://accounts.google.com/o/oauth2/v2/auth",
      "https://oauth2.googleapis.com/token",
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      "https://www.linkedin.com/oauth/v2/accessToken",
      "https://api.linkedin.com/rest/memberSnapshotData?q=criteria",
      "https://api.anthropic.com/v1/messages",
    ]) {
      expect(isAllowedOutboundUrl(url), url).toBe(true);
    }
  });

  it("blocks everything else", () => {
    for (const url of [
      "https://example.com/",
      "https://evil.googleapis.com.attacker.io/x",
      "https://getdex.com/api",
      "https://linkedin.com.evil.io/oauth",
      "not a url",
    ]) {
      expect(isAllowedOutboundUrl(url), url).toBe(false);
    }
  });

  it("blocks plain http even for allowed hosts", () => {
    expect(isAllowedOutboundUrl("http://api.linkedin.com/rest/x")).toBe(false);
  });

  it("outboundFetch throws before any network I/O on a blocked host", async () => {
    await expect(outboundFetch("https://example.com/")).rejects.toBeInstanceOf(
      OutboundBlockedError
    );
  });
});

describe("redirect handling — every hop is allowlist-checked", () => {
  function redirectResponse(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
  }

  it("a redirect to a non-allowlisted host is blocked, not followed", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return redirectResponse("https://evil.example.com/capture");
    }) as typeof fetch;
    try {
      await expect(
        outboundFetch("https://www.linkedin.com/some/path")
      ).rejects.toBeInstanceOf(OutboundBlockedError);
      expect(calls).toEqual(["https://www.linkedin.com/some/path"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a redirect to an allowlisted host is followed, without auth headers cross-origin", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit
    ) => {
      const auth = new Headers(init?.headers).get("authorization");
      seen.push({ url: String(url), auth });
      if (seen.length === 1) {
        return redirectResponse("https://api.linkedin.com/rest/landing");
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const res = await outboundFetch("https://www.linkedin.com/start", {
        headers: { authorization: "Bearer secret" },
      });
      expect(res.status).toBe(200);
      expect(seen[0].auth).toBe("Bearer secret");
      expect(seen[1]).toEqual({
        url: "https://api.linkedin.com/rest/landing",
        auth: null,
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
