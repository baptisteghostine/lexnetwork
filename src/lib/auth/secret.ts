import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";

import { DATA_DIR, db } from "@/db/client";
import { settings } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { generateSecret } from "./session";

// Split from lib/auth/index so non-request code (jobs, sync engines,
// token crypto) can read the secret without pulling in next/headers.

const SECRET_KEY = "auth.session_secret";
const SECRET_FILE = "secret.key";

// The generated secret lives in data/secret.key, NOT in the settings table:
// the whole point of encrypting tokens at rest (SCHEMA.md) is that the
// SQLite file gets backed up and copied around — a key stored inside that
// same file would ship with every backup it is meant to protect. Early
// installs persisted it in settings; that value is migrated out on first
// read (same secret, so existing sessions and encrypted tokens survive).

let cached: string | null = null;

// SESSION_SECRET env var wins if set; otherwise generated once and persisted.
export function getSessionSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (cached) return cached;

  const file = path.join(DATA_DIR, SECRET_FILE);
  try {
    const fromFile = fs.readFileSync(file, "utf8").trim();
    if (fromFile) {
      cached = fromFile;
      return fromFile;
    }
  } catch {
    // No file yet — fall through to migration/generation.
  }

  const legacy = getSetting<string>(SECRET_KEY);
  const secret = legacy ?? generateSecret();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  if (legacy) {
    db.delete(settings).where(eq(settings.key, SECRET_KEY)).run();
  }
  cached = secret;
  return secret;
}
