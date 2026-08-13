import { NextResponse, type NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth";
import { buildGoogleAuthUrl } from "@/lib/sync/google-auth";
import { googleClientCreds } from "@/server/sync/accounts";
import { issueOauthState } from "@/server/sync/oauth-state";

export async function GET(req: NextRequest): Promise<NextResponse> {
  await requireAuth();
  const creds = googleClientCreds();
  if (!creds) {
    return NextResponse.redirect(
      new URL("/settings?connect_error=google-creds", req.url)
    );
  }
  const redirectUri = new URL("/api/google/callback", req.url).toString();
  return NextResponse.redirect(
    buildGoogleAuthUrl({
      clientId: creds.clientId,
      redirectUri,
      state: issueOauthState(),
    })
  );
}
