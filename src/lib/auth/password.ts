import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// scrypt parameters: N=16384, r=8, p=1 (Node defaults), 32-byte key.
// Stored format: scrypt$<salt b64>$<hash b64>

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "base64");
  const expected = Buffer.from(parts[2], "base64");
  const actual = scryptSync(password.normalize("NFKC"), salt, expected.length);
  return timingSafeEqual(actual, expected);
}
