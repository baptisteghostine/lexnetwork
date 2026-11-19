import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ConsentForm } from "@/components/consent-form";
import { getPasswordHash } from "@/lib/auth/password-gate";
import { getSessionSecret } from "@/lib/auth/secret";
import {
  asksForWrite,
  isLoopbackRedirect,
  redirectHost,
  redirectWith,
  resourceForOrigin,
  validateAuthorizeRequest,
  type AuthorizeParams,
} from "@/lib/agent/oauth";
import { publicOriginFromHeaders } from "@/server/sync/request-origin";

export const dynamic = "force-dynamic";

// The agent connector's consent screen (SPEC §14): the page Claude sends
// the owner to when they connect Rolo. It needs no session — the password
// asked for here is the sign-in — and it never redirects anywhere it has
// not first validated.

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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Rolo</h1>
      {children}
    </div>
  );
}

export default async function AuthorizePage({
  searchParams,
}: PageProps<"/oauth/authorize">) {
  const query = await searchParams;
  const params: AuthorizeParams = {};
  const raw: Record<string, string> = {};
  for (const key of PARAMS) {
    const value = query[key];
    // A parameter given twice is ambiguous; treat it as absent.
    if (typeof value === "string" && value !== "") {
      params[key] = value;
      raw[key] = value;
    }
  }

  const origin = publicOriginFromHeaders(await headers());
  const checked = validateAuthorizeRequest(params, {
    secret: getSessionSecret(),
    resource: resourceForOrigin(origin),
  });

  if (!checked.ok) {
    if (checked.redirect) {
      redirect(
        redirectWith(checked.redirectUri, {
          error: checked.error,
          error_description: checked.description,
          state: checked.state,
          iss: origin,
        })
      );
    }
    return (
      <Shell>
        <p className="text-sm font-medium">This connection request can&apos;t be used.</p>
        <p className="text-xs text-muted-foreground">{checked.description}</p>
        <p className="text-xs text-muted-foreground">
          Nothing was shared. Start again from Claude&apos;s connector settings.
        </p>
      </Shell>
    );
  }

  if (!getPasswordHash()) {
    return (
      <Shell>
        <p className="text-sm font-medium">Rolo isn&apos;t set up yet.</p>
        <p className="text-xs text-muted-foreground">
          Create your password in Rolo first, then connect again.
        </p>
      </Shell>
    );
  }

  const { client, redirectUri, state } = checked.request;
  const offerWrite = asksForWrite(checked.request.scope);
  const loopback = isLoopbackRedirect(redirectUri);
  const denyHref = redirectWith(redirectUri, {
    error: "access_denied",
    error_description: "The owner declined the request.",
    state,
    iss: origin,
  });

  return (
    <Shell>
      <div className="space-y-1">
        <p className="text-sm font-medium">Connect to your Rolo?</p>
        <p className="text-xs text-muted-foreground">
          An app calling itself{" "}
          <span className="font-medium text-foreground">&ldquo;{client.name}&rdquo;</span> is
          asking for access.
        </p>
      </div>

      <div className="space-y-2 rounded-md border border-border p-3 text-xs">
        <div>
          <p className="font-medium">It will be able to</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
            <li>Search and read your contacts, notes, timelines, reminders and Today.</li>
            {offerWrite ? (
              <li>
                If you leave the box below ticked: log exchanges, write notes, set reminders, add
                people and tag them — each change listed in Rolo and undoable.
              </li>
            ) : null}
          </ul>
        </div>
        <div>
          <p className="font-medium">It will never be able to</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
            <li>
              {offerWrite
                ? "Delete, merge or archive anything, or overwrite what you typed."
                : "Change, add or delete anything."}
            </li>
            <li>Send a message, or see your password, settings or connected accounts.</li>
          </ul>
        </div>
        <p className="border-t border-border pt-2 text-muted-foreground">
          After you allow, you go back to{" "}
          <span className="font-mono font-medium text-foreground">{redirectHost(redirectUri)}</span>
        </p>
        {loopback ? (
          <p className="text-amber-600 dark:text-amber-400">
            That is a program on this computer. Only continue if you started this yourself, from
            Claude Code or a tool you are running.
          </p>
        ) : null}
      </div>

      {/* The one attack a consent screen has to defeat by words: someone
          else starts a connection from *their* Claude and sends the owner
          the link. Typing the password here would connect their account. */}
      <p className="text-xs font-medium">
        Only allow this if you started it yourself, just now, from your own Claude. If a link
        brought you here unexpectedly, close this page.
      </p>

      <ConsentForm params={raw} denyHref={denyHref} offerWrite={offerWrite} />

      <p className="text-[11px] text-muted-foreground">
        You can disconnect it at any time in Settings → Claude connector.
      </p>
    </Shell>
  );
}
