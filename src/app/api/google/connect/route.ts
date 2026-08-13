import { NextResponse, type NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth";
import { buildGoogleAuthUrl } from "@/lib/sync/google-auth";
import { googleClientCreds } from "@/server/sync/accounts";
import { issueOauthState } from "@/server/sync/oauth-state";
import { publicOrigin } from "@/server/sync/request-origin";

export async function GET(req: NextRequest): Promise<NextResponse> {
  await requireAuth();
  const origin = publicOrigin(req);
  const creds = googleClientCreds();
  if (!creds) {
    return NextResponse.redirect(
      new URL("/settings?connect_error=google-creds", origin)
    );
  }
  const redirectUri = new URL("/api/google/callback", origin).toString();
  return NextResponse.redirect(
    buildGoogleAuthUrl({
      clientId: creds.clientId,
      redirectUri,
      state: issueOauthState(),
    })
  );
}
