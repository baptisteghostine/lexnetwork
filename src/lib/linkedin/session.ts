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
  const bareValues: string[] = [];
  // Split on `;`, newlines, and tabs — a devtools cookies-table row copies
  // as `name<TAB>value`, a header as `name=value; …`.
  for (const chunk of raw.split(/[;\n\r\t]+/)) {
    let trimmed = chunk.trim();
    if (!trimmed) continue;
    // A pasted header may keep its literal `Cookie:` prefix.
    trimmed = trimmed.replace(/^cookie:\s*/i, "");
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      // No `=`: either a cookie *name* from a tab-separated row (ignore —
      // the value arrives as its own chunk) or a bare value paste.
      const value = stripQuotes(trimmed);
      if (value && !/^(li_at|jsessionid)$/i.test(value)) bareValues.push(value);
      continue;
    }
    const name = trimmed.slice(0, eq).trim();
    const value = stripQuotes(trimmed.slice(eq + 1).trim());
    if (name && value) pairs.set(name.toLowerCase(), value);
  }

  let liAt = pairs.get("li_at");
  let jsessionId = pairs.get("jsessionid");
  // Bare values are unambiguous (SPEC §9b AC): JSESSIONID always reads
  // `ajax:<digits>`; anything else long enough is the li_at token.
  for (const value of bareValues) {
    if (!jsessionId && /^ajax:/i.test(value)) jsessionId = value;
    else if (!liAt && value.length >= LI_AT_MIN_LENGTH) liAt = value;
  }

  if (!liAt || liAt.length < LI_AT_MIN_LENGTH) return null;
  if (!jsessionId) return null;

  return { liAt, jsessionId };
}

// A fixed, realistic desktop-Chrome client fingerprint. Owner amendment
// (2026-08-20): the original honest User-Agent was declined by Voyager,
// which only answers its own web client — so to make the owner-opted-in
// sync function at all, the client now presents as that web app. This is
// the "impersonating a browser build" the earlier no-evasion clause
// forbade; the owner reversed that clause with the account-restriction
// risk stated and accepted (CLAUDE.md §LinkedIn, SPEC §9b).
//
// Deliberately STATIC, not randomised: one stable, real browser
// signature. Rotating fingerprints per request is both pointless here
// and the more aggressive form of evasion; a single consistent client is
// what a normal browser looks like. The other safeguards are untouched —
// serial requests, page delay, hard page cap, fail-loud, never-log.
const CHROME_VERSION = "126";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  `Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`;

/** LinkedIn's web client stamps every Voyager call with a client-tracking
 * blob; the endpoint 400s or bounces without a plausible one. */
function xLiTrack(): string {
  return JSON.stringify({
    clientVersion: "1.13.10000",
    mpVersion: "1.13.10000",
    osName: "web",
    timezoneOffset: 0,
    timezone: "Etc/UTC",
    deviceFormFactor: "DESKTOP",
    mpName: "voyager-web",
    displayDensity: 1,
    displayWidth: 1920,
    displayHeight: 1080,
  });
}

/**
 * Headers that make a Voyager request indistinguishable from the LinkedIn
 * web app (the only client the private API answers). `csrf-token` must
 * equal the JSESSIONID cookie value, sent unquoted while the cookie is
 * quoted.
 */
export function buildVoyagerHeaders(
  session: LinkedInSession
): Record<string, string> {
  return {
    cookie: `li_at=${session.liAt}; JSESSIONID="${session.jsessionId}"`,
    "csrf-token": session.jsessionId,
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "x-restli-protocol-version": "2.0.0",
    "x-li-lang": "en_US",
    "x-li-track": xLiTrack(),
    "x-li-page-instance":
      "urn:li:page:d_flagship3_people_connections;rolo-connections-sync",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://www.linkedin.com/mynetwork/invite-connect/connections/",
    "user-agent": USER_AGENT,
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
