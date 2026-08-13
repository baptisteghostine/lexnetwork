import { outboundFetch } from "@/lib/net/fetch";

// Google OAuth for the one owner account (SPEC §9). Pure builders live
// here so tests can assert exactly which scopes leave the building.

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Base consent: metadata-only mail plus read-only calendar. contacts.readonly
// is a separate, optional consent (SPEC §9) — added only when the owner
// explicitly asks for the People import, never silently.
export const GOOGLE_BASE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.metadata",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;
export const GOOGLE_CONTACTS_SCOPE =
  "https://www.googleapis.com/auth/contacts.readonly";

export function buildGoogleAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  includeContacts?: boolean;
}): string {
  const scopes = [
    ...GOOGLE_BASE_SCOPES,
    ...(opts.includeContacts ? [GOOGLE_CONTACTS_SCOPE] : []),
  ];
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: scopes.join(" "),
    state: opts.state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export type GoogleTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(
  body: URLSearchParams,
  now: number
): Promise<GoogleTokens> {
  const res = await outboundFetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Google token endpoint: ${json.error ?? res.status} ${json.error_description ?? ""}`.trim()
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
    scopes: json.scope ?? "",
  };
}

export function exchangeGoogleCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  now?: number;
}): Promise<GoogleTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
    }),
    opts.now ?? Date.now()
  );
}

export function refreshGoogleToken(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  now?: number;
}): Promise<GoogleTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    }),
    opts.now ?? Date.now()
  );
}
