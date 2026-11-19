"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { draftAsText, DRAFT_KIND_LABEL, mailtoLink, outlookWebLink, type DraftKind } from "@/lib/outreach/compose";
import { discardDraftAction, editDraftAction, markDraftSentAction, type OutreachActionResult } from "@/server/outreach";

// One "draft to send" (SPEC §16). Rolo never sends mail: the owner opens
// the draft in their own mail program, sends it there, and says so here.

export type DraftCardData = {
  id: number;
  contactId: number;
  contactName: string;
  campaignName: string | null;
  kind: DraftKind;
  toEmail: string | null;
  subject: string;
  body: string;
  writtenBy: "agent" | "user";
  written: string;
};

/** Tall enough to show the whole email: long lines wrap, so count those too. */
function bodyRows(body: string): number {
  const lines = body.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 80)), 0);
  return Math.min(24, Math.max(6, lines + 1));
}

export function DraftCard({ draft, bcc }: { draft: DraftCardData; bcc: string | null }) {
  const [pending, start] = useTransition();
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [result, setResult] = useState<OutreachActionResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const edited = subject !== draft.subject || body !== draft.body;
  // Links are built from what is on screen, so an edit made here is what opens.
  const compose = { to: draft.toEmail, subject, body, bcc };
  const web = outlookWebLink(compose);
  const mailto = mailtoLink(compose);
  const run = (action: () => Promise<OutreachActionResult>) => start(async () => setResult(await action()));

  return (
    <li className="space-y-2 rounded-md border border-border p-3" data-testid="draft-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-[13px] font-medium">
          <Link href={`/contacts/${draft.contactId}`} className="underline-offset-2 hover:underline">
            {draft.contactName}
          </Link>
          <span className="ml-2 text-[11px] font-normal text-muted-foreground">
            {DRAFT_KIND_LABEL[draft.kind]}
            {draft.campaignName ? ` · ${draft.campaignName}` : ""} · {draft.writtenBy === "agent" ? "written by Claude" : "written by you"} {draft.written}
          </span>
        </p>
        <p className="text-[11px] text-muted-foreground">
          {draft.toEmail ? (
            <>To: <span className="font-mono">{draft.toEmail}</span></>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">No email address in Rolo — add one on their page, or paste it in Outlook.</span>
          )}
        </p>
      </div>
      <Input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} className="h-8 text-[13px]" />
      <Textarea aria-label="Email text" value={body} onChange={(e) => setBody(e.target.value)} rows={bodyRows(body)} className="text-[13px] leading-relaxed" />
      <div className="flex flex-wrap items-center gap-1.5">
        {web ? (
          <Button asChild size="sm">
            <a href={web} target="_blank" rel="noreferrer">Open in Outlook</a>
          </Button>
        ) : null}
        {mailto ? (
          <Button asChild size="sm" variant="outline">
            <a href={mailto}>Open in mail app</a>
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(draftAsText(compose));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        {edited ? (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(() => editDraftAction(draft.id, subject, body))}>
            Save changes
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              // What was sent is what is on screen: keep an edit before logging it.
              if (edited) {
                const saved = await editDraftAction(draft.id, subject, body);
                if (!saved.ok) return setResult(saved);
              }
              setResult(await markDraftSentAction(draft.id));
            })
          }
        >
          {pending ? "…" : "Sent"}
        </Button>
        {confirmDiscard ? (
          <>
            <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => run(() => discardDraftAction(draft.id))}>
              Discard
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDiscard(true)}>
            Discard…
          </Button>
        )}
      </div>
      {draft.toEmail && !web && !mailto ? (
        <p className="text-[11px] text-muted-foreground">This email is too long for a link. Use Copy and paste it into Outlook.</p>
      ) : draft.toEmail && !mailto ? (
        <p className="text-[11px] text-muted-foreground">Too long for the desktop mail app&apos;s link; Outlook on the web and Copy both work.</p>
      ) : null}
      {result ? (
        <p role={result.ok ? "status" : "alert"} className={`text-xs ${result.ok ? "text-muted-foreground" : "text-destructive"}`}>
          {result.ok ? result.message : result.error}
        </p>
      ) : null}
    </li>
  );
}
