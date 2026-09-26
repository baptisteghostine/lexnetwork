"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { enrichContactAction } from "@/server/ai";
import type { ProfileCard as Card } from "@/server/ai-enrich";
import { useFormatDate } from "@/components/timezone-context";

// "What I know" (SPEC §11, 2026-09-26): the AI-written profile card,
// clearly labelled, regenerable, beside — never inside — the contact's
// fields.

export function ProfileCard({
  contactId,
  card,
  updatedAt,
}: {
  contactId: number;
  card: Card | null;
  updatedAt: number | null;
}) {
  const fmt = useFormatDate();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const refresh = () =>
    start(async () => {
      const res = await enrichContactAction({ contactId });
      setError(res.error ?? null);
      router.refresh();
    });

  return (
    <section className="space-y-1.5 rounded-md border border-border bg-accent/20 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Sparkles className="size-3" />
          What I know
          {updatedAt ? (
            <span className="font-normal normal-case tracking-normal">
              · AI, {fmt(updatedAt, { dateStyle: "medium" })}
            </span>
          ) : null}
        </h2>
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={pending} onClick={refresh}>
          <RefreshCw className={`size-3 ${pending ? "animate-spin" : ""}`} />
          {card ? "Refresh" : "Write it"}
        </Button>
      </div>
      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
      {card ? (
        <>
          <p className="text-[13px] leading-relaxed">{card.summary}</p>
          {card.facts.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
              {card.facts.map((f, i) => (
                <div key={i} className="contents">
                  <dt className="text-muted-foreground">{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="text-[12px] text-muted-foreground">
            Relationship {"●".repeat(card.relationship.strength)}
            {"○".repeat(5 - card.relationship.strength)}
            {card.relationship.why ? ` · ${card.relationship.why}` : ""}
          </p>
          {card.openQuestions.length > 0 && (
            <p className="text-[12px] text-muted-foreground">
              Worth asking: {card.openQuestions.join(" · ")}
            </p>
          )}
        </>
      ) : (
        <p className="text-[12px] text-muted-foreground">
          {pending
            ? "Writing…"
            : "No card yet. It is written from your notes, their history and your exchanges — nothing is looked up elsewhere."}
        </p>
      )}
    </section>
  );
}
