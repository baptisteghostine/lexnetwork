"use client";

import { useState, useTransition } from "react";
import { Check, Copy, ExternalLink, PenLine } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { gmailComposeUrl } from "@/lib/ai/draft";
import { draftMessageAction, type DraftResult } from "@/server/ai";

// Drafts in the owner's voice (SPEC §11, 2026-09-26): a message and an
// email ready to send, editable in place, plus two alternative openings.
// Nothing is ever sent from here — copy, or open LinkedIn / Gmail
// compose with the text prefilled.

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-1.5"
      aria-label={label}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

export function DraftDialog({
  contactId,
  changeId,
  label = "Draft message",
  size = "sm",
}: {
  contactId: number;
  changeId?: number;
  label?: string;
  size?: "sm" | "default";
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Exclude<DraftResult, { error: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState("");
  const [message, setMessage] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  function generate() {
    start(async () => {
      const res = await draftMessageAction({ contactId, changeId, intent: intent.trim() || undefined });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setError(null);
      setResult(res);
      setMessage(res.draft.message);
      setSubject(res.draft.email.subject);
      setBody(res.draft.email.body);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && result === null && !pending) generate();
      }}
    >
      <DialogTrigger asChild>
        <Button size={size} variant="outline">
          <PenLine className="size-3.5" />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">Draft in your voice</DialogTitle>
        </DialogHeader>
        <p className="text-[11px] text-muted-foreground">
          Written from your notes, their history and your style guide — edit anything, then
          copy or open where you&rsquo;ll send it. Nothing is sent from here.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="What do you want? e.g. ask for a 20-min call about Santander"
            className="min-w-0 flex-1"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                generate();
              }
            }}
          />
          <Button size="sm" variant="outline" disabled={pending} onClick={generate}>
            {pending ? "Drafting…" : result ? "Redraft" : "Draft"}
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {result && (
          <div className="space-y-4">
            <section className="space-y-1.5">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Message
                </h3>
                <div className="flex items-center gap-1">
                  <CopyButton text={message} label="Copy message" />
                  {result.linkedinUrl && (
                    <Button size="sm" variant="ghost" className="h-6 px-1.5" asChild>
                      <a href={result.linkedinUrl} target="_blank" rel="noreferrer" aria-label="Open LinkedIn">
                        <ExternalLink className="size-3.5" />
                      </a>
                    </Button>
                  )}
                </div>
              </div>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              {result.draft.alternatives.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[11px] text-muted-foreground">Other openings:</p>
                  {result.draft.alternatives.map((alt, i) => (
                    <button
                      key={i}
                      type="button"
                      className="block w-full rounded-md border border-border/60 px-2 py-1 text-left text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
                      title="Use this opening"
                      onClick={() => {
                        // Swap the first sentence of the message for this one.
                        const rest = message.replace(/^[^.!?\n]*[.!?]?\s*/, "");
                        setMessage(`${alt} ${rest}`.trim());
                      }}
                    >
                      {alt}
                    </button>
                  ))}
                </div>
              )}
            </section>
            <section className="space-y-1.5">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Email
                </h3>
                <div className="flex items-center gap-1">
                  <CopyButton text={`Subject: ${subject}\n\n${body}`} label="Copy email" />
                  <Button size="sm" variant="ghost" className="h-6 px-1.5" asChild>
                    <a
                      href={gmailComposeUrl(result.email, subject, body)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open in Gmail"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  </Button>
                </div>
              </div>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={7}
                className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              {!result.email && (
                <p className="text-[11px] text-muted-foreground">
                  No email on file — Gmail opens without a recipient.
                </p>
              )}
            </section>
          </div>
        )}
        {pending && !result && <p className="py-4 text-sm text-muted-foreground">Drafting…</p>}
      </DialogContent>
    </Dialog>
  );
}
