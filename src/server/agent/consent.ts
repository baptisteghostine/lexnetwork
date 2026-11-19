"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { requireAuth } from "@/lib/auth";
import { attemptPassword } from "@/lib/auth/password-gate";
import { getSessionSecret } from "@/lib/auth/secret";
import {
  redirectWith,
  resourceForOrigin,
  validateAuthorizeRequest,
  type AuthorizeParams,
} from "@/lib/agent/oauth";
import { createPendingGrant, revokeGrant } from "@/server/agent/grants";
import { publicOriginFromHeaders } from "@/server/sync/request-origin";

// The two actions of the connector's sign-in (SPEC §14).
//
// Every export of a "use server" file is an endpoint. `authorizeAction` is
// reachable without a session on purpose — it is the consent screen's
// submit — and is safe that way because the only thing that makes it issue
// a code is the owner's password, checked under the login throttle. It
// trusts nothing the form sends: the whole request is validated again
// here, exactly as the page validated it.

export type ConsentState = { error?: string };

const PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;

function paramsFrom(formData: FormData): AuthorizeParams {
  const out: AuthorizeParams = {};
  for (const key of PARAMS) {
    const value = formData.get(key);
    out[key] = typeof value === "string" && value !== "" ? value : null;
  }
  return out;
}

export async function authorizeAction(
  _prev: ConsentState,
  formData: FormData
): Promise<ConsentState> {
  const origin = publicOriginFromHeaders(await headers());
  const checked = validateAuthorizeRequest(paramsFrom(formData), {
    secret: getSessionSecret(),
    resource: resourceForOrigin(origin),
  });
  if (!checked.ok) {
    if (!checked.redirect) return { error: checked.description };
    redirect(
      redirectWith(checked.redirectUri, {
        error: checked.error,
        error_description: checked.description,
        state: checked.state,
        iss: origin,
      })
    );
  }
  const request = checked.request;

  if (formData.get("decision") !== "allow") {
    redirect(
      redirectWith(request.redirectUri, {
        error: "access_denied",
        error_description: "The owner declined the request.",
        state: request.state,
        iss: origin,
      })
    );
  }

  const attempt = attemptPassword(String(formData.get("password") ?? ""));
  if (!attempt.ok) return { error: attempt.error };

  const code = createPendingGrant({
    clientId: request.client.clientId,
    clientName: request.client.name,
    scope: request.scope,
    resource: request.resource,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
  });
  redirect(redirectWith(request.redirectUri, { code, state: request.state, iss: origin }));
}

/** Settings → Claude connector → Disconnect. */
export async function revokeGrantAction(grantId: number): Promise<void> {
  await requireAuth();
  if (!Number.isInteger(grantId)) return;
  revokeGrant(grantId);
  revalidatePath("/settings");
}
