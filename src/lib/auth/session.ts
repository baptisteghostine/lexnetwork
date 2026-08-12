import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Stateless session token: base64url(payload JSON) + "." + base64url(HMAC-SHA256).
// Payload carries only an expiry — single user, nothing else to encode.

export const SESSION_COOKIE = "rolo_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function createSessionToken(
  secret: string,
  now: number = Date.now()
): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: now + SESSION_TTL_MS })
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(
  token: string,
  secret: string,
  now: number = Date.now()
): boolean {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payload, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    ) as { exp?: unknown };
    return typeof parsed.exp === "number" && parsed.exp > now;
  } catch {
    return false;
  }
}

export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
