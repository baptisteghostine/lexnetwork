// LinkedIn session credentials. Pure parsing/format helpers — no network, no DB.
//
// Two cookies matter: `li_at` is the auth token, and `JSESSIONID` doubles as
// the CSRF token that LinkedIn's own web client echoes back in a header.
//
// These values are equivalent to a logged-in session. Nothing in this file
// logs them, and `redactSession` exists so error paths can say what went wrong
// without putting a live token into sync_runs, the jobs table, or the console.

export type LinkedInSession = {
  liAt: string;
  jsessionId: string;
};

/** `li_at` is opaque; guard only against obviously-wrong paste content. */
const LI_AT_MIN_LENGTH = 20;

function stripQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

/**
 * Accepts what a person can actually get out of devtools: a full
 * `Cookie:` header, a couple of `name=value` lines, or the two values on their
 * own. Anything unparseable returns null rather than a half-built session.
 */
export function parseCookieBlob(raw: string): LinkedInSession | null {
  if (!raw.trim()) return null;

  const pairs = new Map<string, string>();
  // Split on both `;` and newlines so a devtools copy works either way.
  for (const chunk of raw.split(/[;\n\r]+/)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = stripQuotes(trimmed.slice(eq + 1).trim());
    if (name && value) pairs.set(name.toLowerCase(), value);
  }

  const liAt = pairs.get("li_at");
  const jsessionId = pairs.get("jsessionid");
  if (!liAt || liAt.length < LI_AT_MIN_LENGTH) return null;
  if (!jsessionId) return null;

  return { liAt, jsessionId };
}

/**
 * Voyager rejects requests whose `csrf-token` header doesn't match the
 * JSESSIONID cookie. The cookie is sent quoted, the header must not be.
 */
export function buildVoyagerHeaders(
  session: LinkedInSession
): Record<string, string> {
  return {
    cookie: `li_at=${session.liAt}; JSESSIONID="${session.jsessionId}"`,
    "csrf-token": session.jsessionId,
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "x-restli-protocol-version": "2.0.0",
    "accept-language": "en-US,en;q=0.9",
    // Identifies the client honestly rather than impersonating a specific
    // browser build. Rolo is not trying to look like something it isn't.
    "user-agent": "Rolo-Personal-CRM/0.1 (+self-hosted; single-user)",
  };
}

/** Safe-to-log fingerprint: enough to tell two sessions apart, useless as a credential. */
export function redactSession(session: LinkedInSession): string {
  return `li_at:…${session.liAt.slice(-4)}`;
}

/**
 * Strips anything token-shaped out of text bound for a log, a job's
 * `last_error`, or a sync-run report. LinkedIn error bodies echo request
 * headers back often enough that this is worth doing unconditionally.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/li_at=[^;\s"]+/gi, "li_at=[redacted]")
    .replace(/JSESSIONID="?[^;\s"]+"?/gi, "JSESSIONID=[redacted]")
    .replace(/"?ajax:\d+"?/gi, "[redacted]");
}
