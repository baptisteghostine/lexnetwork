import { NextResponse, type NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth";
import { outboundFetch } from "@/lib/net/fetch";
import { buildProfileUrl } from "@/lib/sync/gmail";
import { exchangeGoogleCode } from "@/lib/sync/google-auth";
import { ensureSyncJobs } from "@/jobs/scheduler";
import { googleClientCreds, upsertAccount } from "@/server/sync/accounts";
import { verifyOauthState } from "@/server/sync/oauth-state";

function fail(req: NextRequest, code: string): NextResponse {
  return NextResponse.redirect(
    new URL(`/settings?connect_error=${encodeURIComponent(code)}`, req.url)
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  await requireAuth();
  const params = req.nextUrl.searchParams;
  if (!verifyOauthState(params.get("state"))) return fail(req, "bad-state");
  const code = params.get("code");
  if (!code) return fail(req, params.get("error") ?? "no-code");
  const creds = googleClientCreds();
  if (!creds) return fail(req, "google-creds");

  try {
    const tokens = await exchangeGoogleCode({
      code,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      redirectUri: new URL("/api/google/callback", req.url).toString(),
    });
    const profileRes = await outboundFetch(buildProfileUrl(), {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!profileRes.ok) {
      return fail(req, `profile-${profileRes.status}`);
    }
    const profile = (await profileRes.json()) as { emailAddress?: string };
    if (!profile.emailAddress) return fail(req, "no-profile-email");

    upsertAccount({
      provider: "google",
      accountEmail: profile.emailAddress,
      scopes: tokens.scopes,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.expiresAt,
      myAddresses: [profile.emailAddress],
    });
    ensureSyncJobs(Date.now());
    return NextResponse.redirect(new URL("/settings?connected=google", req.url));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "exchange-failed";
    return fail(req, msg.slice(0, 120));
  }
}
