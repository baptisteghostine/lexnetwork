"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  disconnectIntegrationAction,
  saveIntegrationCredsAction,
  syncNowAction,
  updateMyAddressesAction,
  type IntegrationStatus,
  type SyncRunSummary,
} from "@/server/integrations";

// Settings → Integrations: connect/disconnect Google + LinkedIn, view
// sync health (cursors, last runs, errors), trigger a sync now.

function timeAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function RunRow({ run }: { run: SyncRunSummary }) {
  let detail = "";
  try {
    const stats = JSON.parse(run.statsJson ?? "{}") as Record<string, unknown>;
    detail = Object.entries(stats)
      .filter(([, v]) => typeof v === "number" && v !== 0)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
  } catch {
    // ignore
  }
  return (
    <li className="flex items-baseline gap-2 text-xs">
      <span
        className={
          run.status === "success"
            ? "text-emerald-600 dark:text-emerald-400"
            : run.status === "running"
              ? "text-muted-foreground"
              : "text-red-600 dark:text-red-400"
        }
      >
        {run.status}
      </span>
      <span className="text-muted-foreground">
        {run.kind} · {timeAgo(run.startedAt)}
        {detail ? ` · ${detail}` : ""}
        {run.error ? ` · ${run.error.slice(0, 140)}` : ""}
      </span>
    </li>
  );
}

function CredsForm({
  provider,
  configured,
  hint,
}: {
  provider: "google" | "linkedin";
  configured: boolean;
  hint: string;
}) {
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          placeholder={configured ? "Client ID (saved)" : "Client ID"}
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className="w-56"
        />
        <Input
          placeholder={configured ? "Client secret (saved)" : "Client secret"}
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          className="w-56"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={pending || (!clientId && !clientSecret)}
          onClick={() =>
            start(async () => {
              await saveIntegrationCredsAction({
                provider,
                clientId,
                clientSecret,
              });
              setSaved(true);
              setClientId("");
              setClientSecret("");
            })
          }
        >
          {pending ? "Saving…" : "Save"}
        </Button>
        {saved && <span className="text-xs text-muted-foreground">Saved.</span>}
      </div>
    </div>
  );
}

function SyncNowButton({
  kind,
  label,
}: {
  kind: "gmail" | "calendar" | "linkedin";
  label: string;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await syncNowAction({ kind });
            setResult(res.error ?? res.summary ?? null);
          })
        }
      >
        {pending ? "Syncing…" : label}
      </Button>
      {result && (
        <span className="text-xs text-muted-foreground">{result}</span>
      )}
    </span>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const cls =
    status === "active"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-red-600 dark:text-red-400";
  return <span className={`text-xs font-medium ${cls}`}>{status}</span>;
}

function GoogleCard({ data }: { data: IntegrationStatus }) {
  const [pending, start] = useTransition();
  const [addresses, setAddresses] = useState(data.myAddresses.join(", "));
  return (
    <div className="space-y-2.5 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Google</h3>
          <StatusBadge status={data.status} />
        </div>
        {data.connected ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              start(() => disconnectIntegrationAction({ provider: "google" }))
            }
          >
            Disconnect
          </Button>
        ) : (
          <Button size="sm" disabled={!data.credsConfigured} asChild>
            <a href="/api/google/connect">Connect Google</a>
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Gmail metadata (senders, subjects, timestamps — never message bodies)
        and read-only Calendar. Emails you send and meetings you attend become
        interactions automatically.
      </p>
      {!data.connected && (
        <CredsForm
          provider="google"
          configured={data.credsConfigured}
          hint="Create an OAuth client (Web application) in Google Cloud Console with redirect URI <your-rolo-url>/api/google/callback, enable the Gmail and Calendar APIs, then paste the client ID and secret."
        />
      )}
      {data.connected && (
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            {data.accountEmail} ·{" "}
            {data.gmailBackfillDone
              ? `mail cursor ${data.gmailHistoryId ?? "—"}`
              : "backfill in progress"}{" "}
            · calendar {data.calendarSyncToken ? "incremental" : "first sync pending"}
          </p>
          {data.lastError && (
            <p className="text-red-600 dark:text-red-400">{data.lastError}</p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              value={addresses}
              onChange={(e) => setAddresses(e.target.value)}
              className="w-80"
              placeholder="you@gmail.com, alias@work.com"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  await updateMyAddressesAction({ addresses });
                })
              }
            >
              Save my addresses
            </Button>
          </div>
          <p>
            “My addresses” decide email direction — add every alias you send
            from.
          </p>
          <div className="flex gap-2">
            <SyncNowButton kind="gmail" label="Sync mail now" />
            <SyncNowButton kind="calendar" label="Sync calendar now" />
          </div>
          <ul className="space-y-0.5">
            {data.recentRuns.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function LinkedInCard({ data }: { data: IntegrationStatus }) {
  const [pending, start] = useTransition();
  const hasConnections = data.linkedinDomains.includes("CONNECTIONS");
  return (
    <div className="space-y-2.5 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">LinkedIn (automatic)</h3>
          <StatusBadge status={data.status} />
        </div>
        {data.connected ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              start(() =>
                disconnectIntegrationAction({ provider: "linkedin" })
              )
            }
          >
            Disconnect
          </Button>
        ) : (
          <Button size="sm" disabled={!data.credsConfigured} asChild>
            <a href="/api/linkedin/connect">Connect LinkedIn</a>
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Official Member Data Portability API (EU/EEA/Switzerland accounts):
        refreshes your connections weekly without the ZIP ritual, feeding the
        same import engine — job changes included. The ZIP upload keeps
        working either way and remains the only source of message history.
      </p>
      {!data.connected && (
        <CredsForm
          provider="linkedin"
          configured={data.credsConfigured}
          hint="Create an app at developer.linkedin.com, add the 'Member Data Portability API (Member)' product, set redirect URI <your-rolo-url>/api/linkedin/callback, then paste the client ID and secret."
        />
      )}
      {data.connected && (
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            Snapshot domains:{" "}
            {data.linkedinDomains.length > 0
              ? data.linkedinDomains.join(", ")
              : "not discovered yet (LinkedIn prepares the archive after consent — try a sync in a few minutes)"}
          </p>
          {data.connected && data.linkedinDomains.length > 0 && !hasConnections && (
            <p className="text-red-600 dark:text-red-400">
              This app can’t pull CONNECTIONS — keep using the ZIP import.
            </p>
          )}
          {data.linkedinSnapshotAt && (
            <p>Last snapshot: {timeAgo(data.linkedinSnapshotAt)}</p>
          )}
          {data.lastError && (
            <p className="text-red-600 dark:text-red-400">{data.lastError}</p>
          )}
          <SyncNowButton kind="linkedin" label="Sync connections now" />
          <ul className="space-y-0.5">
            {data.recentRuns.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function IntegrationsPanel({
  google,
  linkedin,
}: {
  google: IntegrationStatus;
  linkedin: IntegrationStatus;
}) {
  return (
    <div className="space-y-3">
      <GoogleCard data={google} />
      <LinkedInCard data={linkedin} />
    </div>
  );
}
