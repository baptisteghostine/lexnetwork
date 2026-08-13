import { NextResponse, type NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth";
import { buildLinkedInAuthUrl } from "@/lib/sync/linkedin-portability";
import { linkedinClientCreds } from "@/server/sync/accounts";
import { issueOauthState } from "@/server/sync/oauth-state";
import { publicOrigin } from "@/server/sync/request-origin";

export async function GET(req: NextRequest): Promise<NextResponse> {
  await requireAuth();
  const origin = publicOrigin(req);
  const creds = linkedinClientCreds();
  if (!creds) {
    return NextResponse.redirect(
      new URL("/settings?connect_error=linkedin-creds", origin)
    );
  }
  const redirectUri = new URL("/api/linkedin/callback", origin).toString();
  return NextResponse.redirect(
    buildLinkedInAuthUrl({
      clientId: creds.clientId,
      redirectUri,
      state: issueOauthState(),
    })
  );
}
