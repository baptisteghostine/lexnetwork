import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";

import { publicOrigin } from "../../../src/server/sync/request-origin";

// The bug this guards against: a Next.js dev server behind a reverse proxy
// that terminates TLS upstream (Codespaces, Gitpod) sees req.url as plain
// http on an internal host — using that to build an OAuth redirect_uri
// sends the provider a URL that doesn't match what's registered, and every
// connect attempt 400s with redirect_uri_mismatch no matter how carefully
// the provider-side config is checked.

function fakeReq(headers: Record<string, string>, url: string): NextRequest {
  return { url, headers: new Headers(headers) } as unknown as NextRequest;
}

describe("publicOrigin", () => {
  it("prefers X-Forwarded-Proto/Host over the internal request URL", () => {
    const req = fakeReq(
      {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "effective-space-lamp-76qpvxq66wqfxx9g-3000.app.github.dev",
      },
      "http://localhost:3000/api/google/connect"
    );
    expect(publicOrigin(req)).toBe(
      "https://effective-space-lamp-76qpvxq66wqfxx9g-3000.app.github.dev"
    );
  });

  it("falls back to the plain Host header when X-Forwarded-Host is absent", () => {
    const req = fakeReq(
      { "x-forwarded-proto": "https", host: "rolo.example.com" },
      "http://127.0.0.1:3000/api/google/connect"
    );
    expect(publicOrigin(req)).toBe("https://rolo.example.com");
  });

  it("handles a comma-separated X-Forwarded-Proto (multi-hop proxies)", () => {
    const req = fakeReq(
      { "x-forwarded-proto": "https, http", "x-forwarded-host": "rolo.example.com" },
      "http://localhost:3000/x"
    );
    expect(publicOrigin(req)).toBe("https://rolo.example.com");
  });

  it("falls back to req.url when no forwarded headers are present (plain localhost)", () => {
    const req = fakeReq({}, "http://localhost:3000/api/google/connect");
    expect(publicOrigin(req)).toBe("http://localhost:3000");
  });
});
