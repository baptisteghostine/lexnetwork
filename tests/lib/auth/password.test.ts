import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/lib/auth/password";

describe("password hashing", () => {
  it("verifies the correct password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong horse", hash)).toBe(false);
  });

  it("produces unique salts", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects malformed stored hashes", () => {
    expect(verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(verifyPassword("anything", "bcrypt$a$b")).toBe(false);
  });

  it("treats unicode normalization forms as the same password", () => {
    // "é" as precomposed vs combining sequence
    const hash = hashPassword("café");
    expect(verifyPassword("café", hash)).toBe(true);
  });
});
