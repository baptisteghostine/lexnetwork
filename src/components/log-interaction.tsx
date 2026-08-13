"use client";

import { useState, useTransition } from "react";

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
                });
                if (res.error) setError(res.error);
                else {
                  setOpen(false);
                  setTitle("");
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
