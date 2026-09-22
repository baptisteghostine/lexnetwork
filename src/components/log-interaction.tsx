"use client";

import { useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Markdown } from "@/components/markdown";
import { FormatToolbar, formatTextarea } from "@/components/note-editor";
import { shortcutFormat } from "@/lib/notes/format";
import { logInteractionAction } from "@/server/notes";

const KINDS = [
  { value: "manual", label: "Caught up" },
  { value: "meeting", label: "Meeting" },
  { value: "message", label: "Message" },
  { value: "email", label: "Email" },
] as const;

function toLocalDatetimeValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function LogInteraction({ contactId }: { contactId: number }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("manual");
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState(() => toLocalDatetimeValue(new Date()));
  // Optional markdown notes — saved as a note dated to the interaction
  // (SPEC §2), with the same toolbar the note editor has.
  const [noteMd, setNoteMd] = useState("");
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Log interaction
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log an interaction</DialogTitle>
          <DialogDescription>
            Counts toward keep-in-touch — this resets their cadence clock.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-1.5">
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                onClick={() => setKind(k.value)}
                className={`rounded-md border px-2 py-1 text-xs ${
                  kind === k.value
                    ? "border-foreground bg-accent"
                    : "border-input text-muted-foreground hover:text-foreground"
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label>What happened (optional)</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="coffee at Blue Bottle, quick call…"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>Notes (optional)</Label>
              <FormatToolbar textareaRef={noteRef} value={noteMd} onChange={setNoteMd} />
            </div>
            <textarea
              ref={noteRef}
              value={noteMd}
              rows={Math.min(10, Math.max(3, noteMd.split("\n").length + 1))}
              placeholder="What you talked about, next steps… Markdown works."
              className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 font-mono text-[12.5px] leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onChange={(e) => setNoteMd(e.target.value)}
              onKeyDown={(e) => {
                const format = shortcutFormat(e);
                if (format) {
                  e.preventDefault();
                  formatTextarea(e.currentTarget, noteMd, format, setNoteMd);
                }
              }}
            />
            {noteMd.trim() ? (
              <div className="max-h-40 overflow-y-auto rounded-md border border-border/60 px-2.5 py-1.5">
                <Markdown>{noteMd}</Markdown>
              </div>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label>When</Label>
            <Input
              type="datetime-local"
              value={when}
              max={toLocalDatetimeValue(new Date())}
              onChange={(e) => setWhen(e.target.value)}
            />
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const occurredAt = new Date(when).getTime();
                if (!Number.isFinite(occurredAt)) {
                  setError("Pick a valid date.");
                  return;
                }
                const res = await logInteractionAction(contactId, {
                  kind,
                  title: title.trim(),
                  occurredAt,
                  noteMd: noteMd.trim(),
                });
                if (res.error) setError(res.error);
                else {
                  setOpen(false);
                  setTitle("");
                  setNoteMd("");
                  setWhen(toLocalDatetimeValue(new Date()));
                }
              })
            }
          >
            {pending ? "Logging…" : "Log it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
