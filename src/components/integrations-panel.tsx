"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  disconnectIntegrationAction,
  disconnectVoyagerAction,
  saveIntegrationCredsAction,
  saveVoyagerSessionAction,
  setEnrichEnabledAction,
  setGeocodeEnabledAction,
  setMapboxTokenAction,
  setVoyagerEnabledAction,
  syncNowAction,
  updateMyAddressesAction,
  voyagerSyncNowAction,
  type EnrichStatus,
  type GeocodeStatus,
  type IntegrationStatus,
  type SyncRunSummary,
  type VoyagerStatus,
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
      <span className="min-w-0 text-muted-foreground">
        {run.kind} · {timeAgo(run.startedAt)}
        {detail ? ` · ${detail}` : ""}
        {/* Failures are for diagnosing: show the whole message, wrapped
            and selectable, rather than truncating exactly where the
            useful part starts. */}
        {run.error ? (
          <span className="mt-0.5 block whitespace-pre-wrap break-words font-mono text-[11px] text-red-600 dark:text-red-400">
            {run.error}
          </span>
        ) : null}
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

function VoyagerCard({ data }: { data: VoyagerStatus }) {
  const [pending, start] = useTransition();
  const [cookieBlob, setCookieBlob] = useState("");
  const [message, setMessage] = useState<
    { kind: "error" | "ok"; text: string } | null
  >(null);

  function save() {
    start(async () => {
      const result = await saveVoyagerSessionAction({ cookieBlob });
      if (result.error) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      // Clear immediately on success — no reason to leave a live session
      // token sitting in a DOM node.
      setCookieBlob("");
      setMessage({ kind: "ok", text: "Session saved. Weekly sync is on." });
    });
  }

  function syncNow() {
    start(async () => {
      const result = await voyagerSyncNowAction();
      setMessage(
        result.error
          ? { kind: "error", text: result.error }
          : {
              kind: "ok",
              text: "Sync queued — it starts within a minute and pages slowly through your connections.",
            }
      );
    });
  }

  return (
    <div className="space-y-2.5 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">LinkedIn (session cookie)</h3>
          {data.configured && (
            <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
              connected
            </span>
          )}
        </div>
        {data.configured && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await disconnectVoyagerAction();
                setMessage({ kind: "ok", text: "Session removed." });
              })
            }
          >
            Disconnect
          </Button>
        )}
      </div>
      <div className="space-y-1 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-2.5">
        <p className="text-xs font-medium text-yellow-600 dark:text-yellow-500">
          Read this before turning it on
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          This reads your connection list through LinkedIn&rsquo;s own internal
          API using your logged-in session. Automated access is against
          LinkedIn&rsquo;s User Agreement, and the consequence — an account
          restriction — lands on your account, not on Rolo. Rolo paces requests
          slowly and does nothing to disguise itself; if LinkedIn declines, the
          sync fails and says so rather than trying to get around it. The
          export-ZIP upload remains the sanctioned route and carries no such
          risk.
        </p>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          <b>Best result — paste the whole Cookie header:</b> on linkedin.com
          while logged in, open devtools → <b>Network</b> → click any request
          to linkedin.com → Request Headers → right-click{" "}
          <code>Cookie</code> → Copy value, and paste it below. The extra
          cookies it carries (<code>lidc</code>, <code>bcookie</code>…) are
          often what decides whether LinkedIn answers or bounces you to a
          login page.
        </p>
        <p className="text-xs text-muted-foreground">
          The minimum that also works: just <code>li_at</code> and{" "}
          <code>JSESSIONID</code> from Application → Cookies, any format.
          Cookies rotate when you log in again — if a sync starts failing,
          re-copy them.
        </p>
        <Textarea
          value={cookieBlob}
          onChange={(e) => setCookieBlob(e.target.value)}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          placeholder={'li_at=AQED...\nJSESSIONID="ajax:1234567890"'}
          className="font-mono text-xs"
        />
        <Button
          size="sm"
          onClick={save}
          disabled={pending || !cookieBlob.trim()}
        >
          {pending
            ? "Saving…"
            : data.configured
              ? "Replace session"
              : "Connect"}
        </Button>
      </div>
      {data.configured && (
        <div className="space-y-2 text-xs text-muted-foreground">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={data.enabled}
              onChange={(e) =>
                start(async () => {
                  await setVoyagerEnabledAction({ enabled: e.target.checked });
                })
              }
              disabled={pending}
              className="size-3.5"
            />
            Run automatically once a week
          </label>
          <p>
            New connections are added as contacts; changed titles update
            existing ones and surface as network updates. Rolo never deletes a
            contact because it stopped appearing in the list.
            {data.nextRunAt !== null &&
              ` Next run ${new Date(data.nextRunAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}.`}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={syncNow}
          >
            Sync connections now
          </Button>
          <ul className="space-y-0.5">
            {data.recentRuns.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        </div>
      )}
      {message && (
        <p
          className={`text-xs ${
            message.kind === "error"
              ? "text-red-600 dark:text-red-400"
              : "text-muted-foreground"
          }`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

function ExtensionPairing({
  token,
  enrich,
}: {
  token: string;
  enrich: EnrichStatus;
}) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-medium">Browser extension</h3>
        <span className="text-[11px] text-muted-foreground">
          the only LinkedIn sync that works
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        LinkedIn is behind Cloudflare bot management, which fingerprints the
        TLS handshake — so a server-side sync is refused before it sends a
        header. The extension runs inside your own Chrome, where the request
        genuinely is a browser request. Load it from the{" "}
        <code>extension/</code> folder via{" "}
        <code>chrome://extensions</code> → Developer mode → Load unpacked,
        then paste this token into its popup.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded border border-border bg-muted px-2 py-1 font-mono text-[11px]">
          {shown ? token : "•".repeat(32)}
        </code>
        <Button size="sm" variant="ghost" onClick={() => setShown((s) => !s)}>
          {shown ? "Hide" : "Show"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(token);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <EnrichControls data={enrich} />
    </div>
  );
}

/** Location backfill (SPEC §9d). Off by default: turning it on is the owner
 * accepting per-profile automated access, which is a bigger ask than the
 * connection list — so it needs a deliberate click, not a default. */
function EnrichControls({ data }: { data: EnrichStatus }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const remaining = Math.max(0, data.linkedInContacts - data.located);
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          defaultChecked={data.enabled}
          disabled={pending}
          onChange={(e) =>
            start(async () => {
              await setEnrichEnabledAction({ enabled: e.target.checked });
              router.refresh();
            })
          }
        />
        <span>
          <span className="font-medium">Fill in locations from profiles</span>
          <span className="block text-muted-foreground">
            The connections list carries no location, so each one costs a
            separate profile read. Capped at {data.dailyCap}/day, most
            important people first — press “Fill in locations” in the
            extension while you browse. Same terms as the sync: automated
            access breaches LinkedIn&apos;s User Agreement, and the
            account-restriction risk is yours.
          </span>
        </span>
      </label>
      {data.linkedInContacts > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {data.located} of {data.linkedInContacts} LinkedIn contacts have a
          location
          {remaining > 0
            ? ` · ${remaining} to go, about ${Math.ceil(remaining / Math.max(1, data.dailyCap))} day${Math.ceil(remaining / Math.max(1, data.dailyCap)) === 1 ? "" : "s"} at this rate`
            : " · complete"}
        </p>
      )}
    </div>
  );
}

/** Nominatim city placement (SPEC §7a, decision #4). Off by default —
 * ticking it is the owner configuring the one optional third party that
 * ever sees a location string (and only ever the string). */
function GeocodeCard({ data }: { data: GeocodeStatus }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const left = Math.max(0, data.contactsWithLocation - data.contactsPlaced);
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-medium">City placement</h3>
        <span className="text-[11px] text-muted-foreground">
          OpenStreetMap · free, no account
        </span>
      </div>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          defaultChecked={data.enabled}
          disabled={pending}
          onChange={(e) =>
            start(async () => {
              await setGeocodeEnabledAction({ enabled: e.target.checked });
              router.refresh();
            })
          }
        />
        <span>
          <span className="font-medium">Place cities with OpenStreetMap</span>
          <span className="block text-muted-foreground">
            Turns &ldquo;Zurich, Zurich, Switzerland&rdquo; into a pin on the
            map. Sends only the location text to Nominatim — never names,
            emails, or anything else — one lookup per second, each distinct
            place asked once. A full network takes an hour or two in the
            background.
          </span>
        </span>
      </label>
      {data.contactsWithLocation > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {data.contactsPlaced} of {data.contactsWithLocation} contacts with a
          location are pinned
          {data.enabled && left > 0 ? ` · ${left} queued` : ""}
        </p>
      )}
    </div>
  );
}

/** Mapbox rendering (SPEC §7a, owner-amended 2026-08-24): paste a public
 * token → the map page swaps the bundled SVG for the interactive globe.
 * Clearing the token swaps it straight back. */
function MapboxCard({ configured }: { configured: boolean }) {
  const [pending, start] = useTransition();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const save = (value: string) =>
    start(async () => {
      setError(null);
      const res = await setMapboxTokenAction({ token: value });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setToken("");
      router.refresh();
    });
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-medium">Map rendering</h3>
        <span className="text-[11px] text-muted-foreground">
          {configured ? "Mapbox globe" : "built-in map"}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Paste a Mapbox <span className="font-medium">public token</span>{" "}
        (starts with <code>pk.</code>) and the Map tab becomes the
        interactive Dex-style globe — zoom, pan, tiles. Find it at{" "}
        <a
          href="https://account.mapbox.com/access-tokens/"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          account.mapbox.com → Access tokens
        </a>{" "}
        (the &ldquo;Default public token&rdquo; works). Tiles load in your
        browser with your token; pins still come from Rolo&rsquo;s own
        data. Clear it to go back to the built-in map.
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          placeholder={configured ? "pk.… (saved)" : "pk.…"}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="w-72"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={pending || token.trim() === ""}
          onClick={() => save(token)}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
        {configured && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => save("")}
          >
            Clear
          </Button>
        )}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </div>
  );
}

export function IntegrationsPanel({
  google,
  linkedin,
  voyager,
  extensionToken,
  enrich,
  geocode,
  mapboxConfigured,
}: {
  google: IntegrationStatus;
  linkedin: IntegrationStatus;
  voyager: VoyagerStatus;
  extensionToken: string;
  enrich: EnrichStatus;
  geocode: GeocodeStatus;
  mapboxConfigured: boolean;
}) {
  return (
    <div className="space-y-3">
      <GoogleCard data={google} />
      <LinkedInCard data={linkedin} />
      <ExtensionPairing token={extensionToken} enrich={enrich} />
      <GeocodeCard data={geocode} />
      <MapboxCard configured={mapboxConfigured} />
      <VoyagerCard data={voyager} />
    </div>
  );
}
