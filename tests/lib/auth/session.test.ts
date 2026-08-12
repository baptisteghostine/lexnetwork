import { describe, expect, it } from "vitest";

import {
  createSessionToken,
  SESSION_TTL_MS,
  verifySessionToken,
} from "@/lib/auth/session";

const SECRET = "test-secret-a";

describe("session tokens", () => {
  it("round-trips a valid token", () => {
    const token = createSessionToken(SECRET);
    expect(verifySessionToken(token, SECRET)).toBe(true);
  });

  it("rejects a token signed with a different secret", () => {
    const token = createSessionToken(SECRET);
    expect(verifySessionToken(token, "test-secret-b")).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const token = createSessionToken(SECRET);
    const [payload, mac] = token.split(".");
    const forged =
      Buffer.from(
        JSON.stringify({ exp: Date.now() + 10 * SESSION_TTL_MS })
      ).toString("base64url") + `.${mac}`;
    expect(forged).not.toBe(token);
    expect(verifySessionToken(forged, SECRET)).toBe(false);
    // Original payload with its own mac still verifies.
    expect(verifySessionToken(`${payload}.${mac}`, SECRET)).toBe(true);
  });

  it("rejects an expired token", () => {
    const issuedAt = Date.now() - SESSION_TTL_MS - 1000;
    const token = createSessionToken(SECRET, issuedAt);
    expect(verifySessionToken(token, SECRET)).toBe(false);
  });

  it("rejects garbage", () => {
    expect(verifySessionToken("", SECRET)).toBe(false);
    expect(verifySessionToken("abc", SECRET)).toBe(false);
    expect(verifySessionToken("a.b.c", SECRET)).toBe(false);
  });
});
