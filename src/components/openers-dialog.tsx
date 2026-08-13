"use client";

import { useState, useTransition } from "react";
import { Check, Copy, MessageCircleHeart } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { openersAction } from "@/server/ai";

// Conversation starters (SPEC §11): 3 short openers grounded in the
// owner's notes and the contact's history, each with a copy button.
// Never sent anywhere — the owner pastes them where they like.

export function OpenersDialog({
  contactId,
  changeId,
  label = "Draft openers",
  size = "sm",
}: {
  contactId: number;
  changeId?: number;
  label?: string;
  size?: "sm" | "default";
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [openers, setOpeners] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  function generate() {
    start(async () => {
      const result = await openersAction({ contactId, changeId });
      if (result.error) {
        setError(result.error);
        setOpeners(null);
      } else {
        setError(null);
        setOpeners(result.openers ?? null);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && openers === null && !pending) generate();
      }}
    >
      <DialogTrigger asChild>
        <Button size={size} variant="outline">
          <MessageCircleHeart className="size-3.5" />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">Conversation starters</DialogTitle>
        </DialogHeader>
        <p className="text-[11px] text-muted-foreground">
          AI-generated from your notes and their history — review before
          sending.
        </p>
        {pending && (
          <p className="py-4 text-sm text-muted-foreground">Drafting…</p>
        )}
        {error && <p className="py-2 text-sm text-destructive">{error}</p>}
        {openers && (
          <ul className="space-y-2">
            {openers.map((text, i) => (
              <li
                key={i}
                className="flex items-start gap-2 rounded-md border border-border p-2.5"
              >
                <p className="flex-1 text-[13px] leading-relaxed">{text}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5"
                  aria-label="Copy opener"
                  onClick={async () => {
                    await navigator.clipboard.writeText(text);
                    setCopied(i);
                    setTimeout(() => setCopied(null), 1500);
                  }}
                >
                  {copied === i ? (
                    <Check className="size-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {openers && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={generate}
          >
            Regenerate
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
