"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { acceptGuessAction, confirmGuessAction, dismissGuessAction, type FirmActionResult } from "@/server/firms";

// An address Rolo worked out (SPEC §17), offered with the evidence for it.
// It reaches the contact only by the owner's click here.

export type GuessView = { email: string; strength: "strong" | "fair" | "weak"; evidence: string };

const STRENGTH_LABEL: Record<GuessView["strength"], string> = {
  strong: "likely",
  fair: "plausible",
  weak: "a long shot",
};

export function EmailGuess({ contactId, guess, compact = false }: { contactId: number; guess: GuessView; compact?: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FirmActionResult | null>(null);
  const run = (action: () => Promise<FirmActionResult>) => start(async () => setResult(await action()));
  return (
    <span className={compact ? "inline-flex flex-wrap items-baseline gap-x-2 gap-y-1" : "flex flex-col gap-1"} data-testid="email-guess">
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[12px]">{guess.email}</span>
        <span className="rounded border border-amber-500/40 px-1 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400" title={guess.evidence}>
          guess · {STRENGTH_LABEL[guess.strength]}
        </span>
      </span>
      {compact ? null : <span className="text-[11px] text-muted-foreground">{guess.evidence}</span>}
      <span className="flex items-center gap-1.5">
        <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={pending} onClick={() => run(() => acceptGuessAction(contactId, guess.email))}>
          Use this address
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={pending} onClick={() => run(() => dismissGuessAction(contactId, guess.email))}>
          Not this
        </Button>
      </span>
      {result && !result.ok ? (
        <span role="alert" className="text-[11px] text-destructive">
          {result.error}
        </span>
      ) : null}
    </span>
  );
}

/** The mark on an address that began as a guess, with the way to say it works. */
export function GuessMark({ contactId, email, confirmed }: { contactId: number; email: string; confirmed: boolean }) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(confirmed);
  if (done) {
    return (
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground" title="This address began as Rolo's guess and has since been confirmed.">
        guess, confirmed
      </span>
    );
  }
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span
        className="rounded border border-amber-500/40 px-1 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400"
        title="Rolo worked this address out from the firm's format. It has not been proven by a reply."
      >
        guess
      </span>
      <button
        type="button"
        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await confirmGuessAction(contactId, email);
            if (res.ok) setDone(true);
          })
        }
      >
        it works
      </button>
    </span>
  );
}
