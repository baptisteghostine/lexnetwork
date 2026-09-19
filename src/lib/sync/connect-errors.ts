// What the Integrations tab says when an OAuth round trip comes back with
// `?connect_error=<code>`. The codes are the callback routes' own (bad-state,
// google-creds, profile-403…) or whatever the provider put in `error` /
// its token-endpoint reply. Pure, so the wording is unit-testable and the
// page stays a one-liner.

export type ConnectNotice = { kind: "ok" | "error"; text: string };

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  linkedin: "LinkedIn",
};

export function describeConnectError(code: string): string {
  const c = code.trim();
  if (c === "bad-state") {
    return "The sign-in took more than 15 minutes, or it started from a different Rolo address than it came back to. Start again from this page, on the address you want to keep using.";
  }
  if (c === "access_denied") {
    return "Google didn't grant access. Either the request was cancelled on Google's screen, or this account isn't listed under Test users on the OAuth consent screen (required while the app is in Testing).";
  }
  if (c === "google-creds" || c === "linkedin-creds") {
    return "The client ID and secret aren't saved yet — paste them below and save, then connect.";
  }
  if (c === "no-code") {
    return "The provider came back without an authorization code. Try again.";
  }
  if (c === "no-profile-email") {
    return "Google didn't return an email address for the account. Try again; if it repeats, check that the Gmail API is enabled for the OAuth client's project.";
  }
  const profile = /^profile-(\d+)$/.exec(c);
  if (profile) {
    return `Google refused the profile read (HTTP ${profile[1]}). Enable the Gmail API for the OAuth client's project in Google Cloud Console, then connect again.`;
  }
  if (/redirect_uri_mismatch/i.test(c)) {
    return "The redirect URI Rolo sent isn't registered on the OAuth client. In Google Cloud Console → Credentials, add this Rolo address followed by /api/google/callback, then connect again.";
  }
  if (/invalid_client/i.test(c)) {
    return "Google rejected the client ID or secret. Re-copy both from Google Cloud Console → Credentials and save them below.";
  }
  if (/invalid_grant/i.test(c)) {
    return "Google rejected the authorization code — usually a stale tab. Start the connection again from this page.";
  }
  return `Connecting failed: ${c}`;
}

/** The page reads the two query params and turns them into one notice. */
export function connectNotice(params: {
  connected?: string | string[];
  connect_error?: string | string[];
}): ConnectNotice | null {
  const err = Array.isArray(params.connect_error) ? params.connect_error[0] : params.connect_error;
  if (err) return { kind: "error", text: describeConnectError(err) };
  const ok = Array.isArray(params.connected) ? params.connected[0] : params.connected;
  if (ok) {
    const label = PROVIDER_LABELS[ok] ?? ok;
    return { kind: "ok", text: `${label} connected. The first sync starts within a few seconds.` };
  }
  return null;
}
