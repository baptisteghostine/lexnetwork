import { NextResponse, type NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth";
import { buildLinkedInAuthUrl } from "@/lib/sync/linkedin-portability";
import { linkedinClientCreds } from "@/server/sync/accounts";
import { issueOauthState } from "@/server/sync/oauth-state";

export async function GET(req: NextRequest): Promise<NextResponse> {
  await requireAuth();
  const creds = linkedinClientCreds();
  if (!creds) {
    return NextResponse.redirect(
      new URL("/settings?connect_error=linkedin-creds", req.url)
    );
  }
  const redirectUri = new URL("/api/linkedin/callback", req.url).toString();
  return NextResponse.redirect(
    buildLinkedInAuthUrl({
      clientId: creds.clientId,
      redirectUri,
      state: issueOauthState(),
    })
  );
}
