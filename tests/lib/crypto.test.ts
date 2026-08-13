import { describe, expect, it } from "vitest";

import { decryptToken, encryptToken } from "../../src/lib/crypto";

describe("token box", () => {
  const secret = "test-secret-for-tokens";

  it("round-trips a token", () => {
    const boxed = encryptToken("ya29.a0AfH6SMB-token-value", secret);
    expect(boxed.startsWith("v1.")).toBe(true);
    expect(decryptToken(boxed, secret)).toBe("ya29.a0AfH6SMB-token-value");
  });

  it("produces distinct ciphertexts for the same plaintext (fresh IV)", () => {
    expect(encryptToken("same", secret)).not.toBe(encryptToken("same", secret));
  });

  it("returns null for a tampered box", () => {
    const boxed = encryptToken("secret-token", secret);
    const tampered = boxed.slice(0, -4) + (boxed.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(decryptToken(tampered, secret)).toBeNull();
  });

  it("returns null under a rotated secret", () => {
    const boxed = encryptToken("secret-token", secret);
    expect(decryptToken(boxed, "a-different-secret")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(decryptToken("", secret)).toBeNull();
    expect(decryptToken("v1.", secret)).toBeNull();
    expect(decryptToken("v2.abcd", secret)).toBeNull();
    expect(decryptToken("not-a-box", secret)).toBeNull();
  });
});
