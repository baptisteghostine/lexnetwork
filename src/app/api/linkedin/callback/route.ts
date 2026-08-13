import { NextResponse, type NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth";
import {
  exchangeLinkedInCode,
  LINKEDIN_SCOPE,
} from "@/lib/sync/linkedin-portability";
import { ensureSyncJobs } from "@/jobs/scheduler";
import { linkedinClientCreds, upsertAccount } from "@/server/sync/accounts";
import { discoverSnapshotDomains } from "@/server/sync/linkedin";
import { verifyOauthState } from "@/server/sync/oauth-state";
import { publicOrigin } from "@/server/sync/request-origin";

function fail(req: NextRequest, code: string): NextResponse {
  return NextResponse.redirect(
    new URL(
      `/settings?connect_error=${encodeURIComponent(code)}`,
      publicOrigin(req)
    )
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  await requireAuth();
  const origin = publicOrigin(req);
  const params = req.nextUrl.searchParams;
  if (!verifyOauthState(params.get("state"))) return fail(req, "bad-state");
  const code = params.get("code");
  if (!code) return fail(req, params.get("error") ?? "no-code");
  const creds = linkedinClientCreds();
  if (!creds) return fail(req, "linkedin-creds");

  try {
    const tokens = await exchangeLinkedInCode({
      code,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      redirectUri: new URL("/api/linkedin/callback", origin).toString(),
    });
    // Observe which snapshot domains this token can actually pull —
    // stored on the account row and shown in Settings, because LinkedIn
    // varies the set and CONNECTIONS is the one the sync needs.
    let domains: string[] = [];
    try {
      domains = await discoverSnapshotDomains(tokens.accessToken);
    } catch {
      // The snapshot can lag right after consent (LinkedIn prepares the
      // archive asynchronously) — connect anyway; sync re-discovers.
    }
    upsertAccount({
      provider: "linkedin",
      accountEmail: "LinkedIn member",
      scopes: LINKEDIN_SCOPE,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.expiresAt,
      linkedinDomains: domains,
    });
    ensureSyncJobs(Date.now());
    return NextResponse.redirect(
      new URL("/settings?connected=linkedin", origin)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "exchange-failed";
    return fail(req, msg.slice(0, 120));
  }
}
