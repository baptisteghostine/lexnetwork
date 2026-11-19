"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { revokeGrantAction } from "@/server/agent/consent";
import { setAgentWriteModeAction } from "@/server/agent/owner-actions";

// Settings → Claude connector (SPEC §14): the address to paste into
// Claude, which apps the owner has let in, a way to shut each out, and
// what they have been asking for.

export type ConnectorGrant = {
  id: number;
  clientName: string;
  scope: string;
  connectedAt: string;
  lastUsed: string | null;
};

export type ConnectorCall = {
  id: number;
  tool: string;
  status: string;
  summary: string | null;
  error: string | null;
  at: string;
};

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded border border-border bg-muted px-2 py-1 font-mono text-[11px]">
          {value}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

function GrantRow({ grant }: { grant: ConnectorGrant }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium">{grant.clientName}</p>
        <p className="text-[11px] text-muted-foreground">
          {grant.scope.split(" ").includes("write") ? "Read and add" : "Read-only"} · connected{" "}
          {grant.connectedAt}
          {grant.lastUsed ? ` · last used ${grant.lastUsed}` : " · not used yet"}
        </p>
      </div>
      {confirming ? (
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() => start(() => revokeGrantAction(grant.id))}
          >
            {pending ? "…" : "Disconnect"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
          Disconnect
        </Button>
      )}
    </li>
  );
}

export function ConnectorPanel({
  url,
  isHttps,
  staticClientId,
  grants,
  calls,
  writeMode,
  queued,
}: {
  url: string;
  isHttps: boolean;
  staticClientId: string;
  grants: ConnectorGrant[];
  calls: ConnectorCall[];
  writeMode: "apply" | "review";
  /** Proposals waiting for the owner on the activity page. */
  queued: number;
}) {
  const [modePending, startMode] = useTransition();
  // Shown as chosen the moment it is clicked; the server catches up.
  const [mode, setMode] = useState(writeMode);
  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-md border border-border p-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[13px] font-medium">Connect Claude</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          In Claude, open Settings → Connectors → Add custom connector, paste this address, and
          sign in with your Rolo password when asked. Claude can then search and read your
          contacts, notes and timelines — and, if you tick the box when signing in, log exchanges,
          write notes, set reminders, add people, tag them and set how often to keep in touch. It can never delete, merge or
          overwrite what you typed. A connection made before this option existed is read-only:
          disconnect it and connect again to change that.
        </p>
        <CopyRow label="Connector address" value={url} />
        {isHttps ? null : (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            This address is not HTTPS. Claude only connects to a public HTTPS address — open Rolo
            at its public address and copy the link from there.
          </p>
        )}
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">If Claude asks for an OAuth client ID</summary>
          <div className="mt-2 space-y-2">
            <p>
              Normally it does not: leave the advanced settings alone and Claude registers itself.
              If you choose &ldquo;use your own OAuth client&rdquo;, enter this ID and leave the
              secret empty.
            </p>
            <CopyRow label="OAuth client ID" value={staticClientId} />
          </div>
        </details>
      </div>

      <div className="rounded-md border border-border p-3">
        <h3 className="text-[13px] font-medium">Connected apps</h3>
        {grants.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">Nothing is connected.</p>
        ) : (
          <ul className="mt-1 divide-y divide-border">
            {grants.map((g) => (
              <GrantRow key={g.id} grant={g} />
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-medium">What Claude changes</h3>
          <Link
            href="/agent-activity"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {queued > 0 ? `Review ${queued} waiting →` : "See and undo changes →"}
          </Link>
        </div>
        <fieldset className="space-y-1.5 text-xs" aria-busy={modePending}>
          <legend className="sr-only">How Claude&apos;s changes are applied</legend>
          {(
            [
              ["apply", "Apply straight away", "Each change is listed and can be undone."],
              ["review", "Ask me first", "Changes wait on the activity page until you approve them."],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="flex items-start gap-2">
              <input
                type="radio"
                name="agent-write-mode"
                value={value}
                checked={mode === value}
                onChange={() => {
                  setMode(value);
                  startMode(() => setAgentWriteModeAction(value));
                }}
                className="mt-0.5 size-3.5 accent-primary"
              />
              <span>
                <span className="font-medium">{label}</span>
                <span className="text-muted-foreground"> — {hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </div>

      <div className="rounded-md border border-border p-3">
        <h3 className="text-[13px] font-medium">Recent requests</h3>
        {calls.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">No requests yet.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {calls.map((c) => (
              <li key={c.id} className="flex items-baseline gap-2 text-xs">
                <span
                  className={
                    c.status === "success"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : c.status === "refused" || c.status === "queued" || c.status === "rejected"
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-red-600 dark:text-red-400"
                  }
                >
                  {c.status}
                </span>
                <span className="min-w-0 text-muted-foreground">
                  <span className="text-foreground">{c.summary ?? c.tool}</span> · {c.at}
                  {c.error ? (
                    <span className="mt-0.5 block whitespace-pre-wrap break-words font-mono text-[11px]">
                      {c.error}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
