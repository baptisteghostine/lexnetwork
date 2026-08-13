import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

// OAuth tokens at rest are encrypted (SCHEMA.md `integration_accounts`):
// single-user box, but the SQLite file gets backed up and copied around,
// so refresh tokens must not sit plaintext in backups. Key is derived
// from the session secret; rotating that secret invalidates stored
// tokens, which surfaces as a "reconnect" status — acceptable.

const VERSION = "v1";
const KDF_SALT = "rolo-token-box";

const keyCache = new Map<string, Buffer>();

function deriveKey(secret: string): Buffer {
  let key = keyCache.get(secret);
  if (!key) {
    key = scryptSync(secret, KDF_SALT, 32);
    keyCache.set(secret, key);
  }
  return key;
}

export function encryptToken(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([iv, tag, ct]).toString("base64url")}`;
}

/** Returns null on tampering, truncation, or a rotated secret. */
export function decryptToken(boxed: string, secret: string): string | null {
  if (!boxed.startsWith(`${VERSION}.`)) return null;
  const raw = Buffer.from(boxed.slice(VERSION.length + 1), "base64url");
  if (raw.length < 12 + 16 + 1) return null;
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
      "utf8"
    );
  } catch {
    return null;
  }
}
