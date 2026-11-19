"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  deleteWhatsAppDataAction,
  linkWhatsAppAction,
  renameWhatsAppAction,
  setWhatsAppHistoryFromAction,
  setWhatsAppSyncAction,
  type WhatsAppActionResult,
} from "@/server/whatsapp";

// The contact page's WhatsApp panel (SPEC §15). Everything Rolo does with
// WhatsApp is driven from here, one person at a time: link their chat by
// number, bring history in, turn sync on or off, or remove it all again.

export type WhatsAppPanelLink = {
  number: string;
  savedName: string;
  syncEnabled: boolean;
  /** YYYY-MM-DD, or "" when history starts at the link. */
  historyFrom: string;
  linkedOn: string;
  lastSynced: string | null;
  messages: number;
  withText: number;
  first: string | null;
  last: string | null;
  summaryMd: string | null;
  summaryCovers: string | null;
  summaryUpdated: string | null;
  unsummarised: number;
  scheduledForClearing: number;
};

type ExportResponse =
  | { ok: true; added: number; alreadyThere: number; total: number; timezone: string; dateOrder: string; dateOrderAssumed: boolean; skipped: number }
  | { ok: false; error: string; senders?: string[] };

function Status({ result }: { result: WhatsAppActionResult | null }) {
  if (!result) return null;
  if (result.ok) return result.message ? <p role="status" className="text-xs text-muted-foreground">{result.message}</p> : null;
  return <p role="alert" className="text-xs text-destructive">{result.error}</p>;
}

function LinkForm({ contactId, suggestedNumber }: { contactId: number; suggestedNumber: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<WhatsAppActionResult | null>(null);
  const [number, setNumber] = useState(suggestedNumber);
  const [savedName, setSavedName] = useState("");
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setResult(await linkWhatsAppAction(contactId, number, savedName)));
      }}
    >
      <p className="text-xs text-muted-foreground">
        Link this person&apos;s one-to-one chat. Rolo then deals with this chat only — nothing else in your WhatsApp.
      </p>
      <div className="space-y-1">
        <Label htmlFor="wa-number" className="text-[11px]">Their WhatsApp number</Label>
        <Input id="wa-number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+44 7911 123456" inputMode="tel" required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="wa-saved-name" className="text-[11px]">Name they are saved under in WhatsApp</Label>
        <Input id="wa-saved-name" value={savedName} onChange={(e) => setSavedName(e.target.value)} placeholder="e.g. John" maxLength={80} required />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "…" : "Link chat"}
      </Button>
      <Status result={result} />
    </form>
  );
}

function ExportUpload({ contactId, savedName, timezone }: { contactId: number; savedName: string; timezone: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<ExportResponse | null>(null);
  const [theirName, setTheirName] = useState("");

  async function upload(name?: string) {
    const file = input.current?.files?.[0];
    if (!file) {
      setResponse({ ok: false, error: "Choose the export file first." });
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("contactId", String(contactId));
      if (name) form.set("theirName", name);
      const res = await fetch("/api/whatsapp/export", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({ ok: false, error: "The upload failed." }))) as ExportResponse;
      setResponse(body);
      if (body.ok) router.refresh();
    } catch {
      setResponse({ ok: false, error: "The upload failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="text-xs">
      <summary className="cursor-pointer select-none font-medium">Upload a phone export (older history)</summary>
      <div className="mt-2 space-y-2">
        <p className="text-muted-foreground">
          On your phone: open the chat → their name → Export Chat → Without Media. Upload the .zip (or the _chat.txt
          inside it). Times are read as {timezone}
          {timezone === "UTC" ? " — if your phone is on UK time, set Europe/London in Settings → General first" : ""}.
        </p>
        <input ref={input} type="file" accept=".zip,.txt,text/plain,application/zip" aria-label="WhatsApp export file" className="block w-full text-[11px]" />
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => upload()}>
          {busy ? "Importing…" : "Import export"}
        </Button>
        {response?.ok ? (
          <p role="status" className="text-muted-foreground">
            Imported {response.added} new message{response.added === 1 ? "" : "s"}
            {response.alreadyThere ? `; ${response.alreadyThere} were already in Rolo` : ""}. Dates read as {response.dateOrder}
            {response.dateOrderAssumed ? " (assumed — the file could be read either way)" : ""}, in {response.timezone}.
          </p>
        ) : null}
        {response && !response.ok ? (
          <div className="space-y-1.5">
            <p role="alert" className="text-destructive">{response.error}</p>
            {response.senders ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <select
                  aria-label="Which name is theirs"
                  value={theirName}
                  onChange={(e) => setTheirName(e.target.value)}
                  className="rounded border border-border bg-background px-2 py-1"
                >
                  <option value="">Which one is {savedName}?</option>
                  {response.senders.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <Button type="button" size="sm" disabled={busy || !theirName} onClick={() => upload(theirName)}>
                  Import with that name
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

export function WhatsAppPanel({
  contactId,
  link,
  suggestedNumber,
  timezone,
  collectorSeen,
}: {
  contactId: number;
  link: WhatsAppPanelLink | null;
  suggestedNumber: string;
  timezone: string;
  /** When the laptop collector last checked in, or null if it never has. */
  collectorSeen: string | null;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<WhatsAppActionResult | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [historyFrom, setHistoryFrom] = useState(link?.historyFrom ?? "");
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(link?.savedName ?? "");
  // Shown as chosen the moment it is clicked; put back if the server refuses.
  const [syncOn, setSyncOn] = useState(link?.syncEnabled ?? false);
  const run = (action: () => Promise<WhatsAppActionResult>) => start(async () => setResult(await action()));

  return (
    <section className="space-y-3" aria-label="WhatsApp">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">WhatsApp</h3>
      {!link ? (
        <LinkForm contactId={contactId} suggestedNumber={suggestedNumber} />
      ) : (
        <div className="space-y-3">
          <div className="text-xs">
            <p>
              <span className="font-medium">{link.number}</span>
              <span className="text-muted-foreground"> · saved in WhatsApp as </span>
              {renaming ? null : <span className="font-medium">&ldquo;{link.savedName}&rdquo;</span>}
              {renaming ? null : (
                <button type="button" className="ml-1.5 text-muted-foreground underline-offset-2 hover:underline" onClick={() => setRenaming(true)}>
                  change
                </button>
              )}
            </p>
            {renaming ? (
              <form
                className="mt-1.5 flex gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  start(async () => {
                    const res = await renameWhatsAppAction(contactId, name);
                    setResult(res);
                    if (res.ok) setRenaming(false);
                  });
                }}
              >
                <Input aria-label="Name they are saved under in WhatsApp" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
                <Button type="submit" size="sm" disabled={pending}>Save</Button>
              </form>
            ) : null}
            <p className="mt-1 text-muted-foreground">
              {link.messages === 0
                ? "No messages in Rolo yet."
                : `${link.messages} message${link.messages === 1 ? "" : "s"}, ${link.first} – ${link.last}${
                    link.withText < link.messages ? ` · exact text kept for ${link.withText}` : ""
                  }`}
            </p>
          </div>

          <div className="space-y-1.5 rounded-md border border-border p-2.5 text-xs">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={syncOn}
                onChange={(e) => {
                  const wanted = e.target.checked;
                  setSyncOn(wanted);
                  start(async () => {
                    const res = await setWhatsAppSyncAction(contactId, wanted);
                    setResult(res);
                    if (!res.ok) setSyncOn(!wanted);
                  });
                }}
                className="mt-0.5 size-3.5 accent-primary"
              />
              <span>
                <span className="font-medium">Keep this chat in sync</span>
                <span className="block text-muted-foreground">
                  {collectorSeen === null
                    ? "The laptop collector has not connected to Rolo yet, so nothing syncs automatically. Your choice is saved; use the phone export below until it is set up."
                    : syncOn
                      ? `Last synced ${link.lastSynced ?? "— not yet"} · collector last seen ${collectorSeen}`
                      : `Off — the collector is not asked for this chat. Collector last seen ${collectorSeen}.`}
                </span>
              </span>
            </label>
            <form
              className="flex flex-wrap items-end gap-1.5 pt-1"
              onSubmit={(e) => {
                e.preventDefault();
                run(() => setWhatsAppHistoryFromAction(contactId, historyFrom));
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="wa-history-from" className="text-[11px]">Import history from</Label>
                <Input id="wa-history-from" type="date" value={historyFrom} onChange={(e) => setHistoryFrom(e.target.value)} className="h-8 w-40" />
              </div>
              <Button type="submit" size="sm" variant="outline" disabled={pending || historyFrom === link.historyFrom}>
                Set
              </Button>
              <p className="basis-full text-muted-foreground">
                {link.historyFrom ? "The collector is asked for this chat from that date." : `Without a date, sync starts from when the chat was linked (${link.linkedOn}).`}
              </p>
            </form>
          </div>

          <ExportUpload contactId={contactId} savedName={link.savedName} timezone={timezone} />

          <details className="text-xs" open={Boolean(link.summaryMd)}>
            <summary className="cursor-pointer select-none font-medium">Summary of older messages</summary>
            <div className="mt-2 space-y-1.5">
              {link.summaryMd ? (
                <>
                  <p className="text-[11px] text-muted-foreground">
                    Covers everything up to {link.summaryCovers} · updated {link.summaryUpdated}
                  </p>
                  <div className="rounded-md border border-border/60 bg-accent/20 px-2.5 py-2">
                    <Markdown>{link.summaryMd}</Markdown>
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground">
                  None yet. Exact text is kept for 90 days; it is only ever cleared after Claude has folded it into this
                  summary, and a week after that.
                </p>
              )}
              {link.unsummarised > 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {link.unsummarised} message{link.unsummarised === 1 ? "" : "s"} not yet in the summary
                  {link.scheduledForClearing > 0 ? ` · ${link.scheduledForClearing} summarised and due to be cleared` : ""}.
                </p>
              ) : null}
            </div>
          </details>

          <div className="border-t border-border pt-2 text-xs">
            {confirmingDelete ? (
              <div className="space-y-1.5">
                <p>
                  This removes every WhatsApp message, the summary and the WhatsApp timeline rows Rolo holds for this person, and
                  unlinks the chat. It cannot be undone. Their other Rolo data stays, and nothing in WhatsApp itself changes.
                </p>
                <div className="flex gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const res = await deleteWhatsAppDataAction(contactId);
                        setResult(res);
                        setConfirmingDelete(false);
                      })
                    }
                  >
                    {pending ? "…" : "Yes, delete WhatsApp data"}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <button type="button" className="text-muted-foreground underline-offset-2 hover:text-destructive hover:underline" onClick={() => setConfirmingDelete(true)}>
                Delete WhatsApp data…
              </button>
            )}
          </div>
        </div>
      )}
      <Status result={result} />
    </section>
  );
}
