import { NextRequest, NextResponse } from "next/server";

import { extensionTokenMatches } from "@/server/sync/extension-pairing";

// The bits every extension route shares (SPEC §9c): the CORS headers a
// chrome-extension:// origin needs, and the bearer check. Auth is the
// pairing token, not the session cookie — the request is cross-origin,
// where a SameSite=Lax cookie is never sent.

export const EXTENSION_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

export function extensionOptions(): NextResponse {
  return new NextResponse(null, { status: 204, headers: EXTENSION_CORS });
}

export function extensionJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: EXTENSION_CORS });
}

/** The 401 to return, or null when the token is good. */
export function extensionUnauthorized(req: NextRequest): NextResponse | null {
  const auth = req.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  return extensionTokenMatches(token) ? null : extensionJson({ error: "unauthorized" }, 401);
}
