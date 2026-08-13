import { getSetting, setSetting } from "@/lib/settings";
import { generateSecret } from "./session";

// Split from lib/auth/index so non-request code (jobs, sync engines,
// token crypto) can read the secret without pulling in next/headers.

const SECRET_KEY = "auth.session_secret";

// SESSION_SECRET env var wins if set; otherwise generated once and persisted.
export function getSessionSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let secret = getSetting<string>(SECRET_KEY);
  if (!secret) {
    secret = generateSecret();
    setSetting(SECRET_KEY, secret);
  }
  return secret;
}
