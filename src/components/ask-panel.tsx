"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { askNetworkAction, type AskResult } from "@/server/ask";

// Ask your network (SPEC §11): the question box. Answers always ground in
// real contacts (validated server-side) and say how many profiles were
// shared with the model — transparency is part of the feature.

const SOURCE_LABEL = {
  filter: "matched by compiled filters",
  search: "matched by full-text search",
  network: "your warmest contacts (no filter matched)",
} as const;

export function AskPanel() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // `a` anywhere navigates here with #ask — focus on arrival.
  useEffect(() => {
    if (window.location.hash === "#ask") inputRef.current?.focus();
  }, []);

  const ask = () => {
    const q = question.trim();
    if (q.length < 5 || pending) return;
    start(async () => {
      setResult(await askNetworkAction({ question: q }));
    });
  };

  return (
    <section id="ask" className="max-w-2xl space-y-3 px-5 py-4">
      <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Sparkles className="size-3.5" />
        Ask your network
      </h2>
      <div className="space-y-2">
        <textarea
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
          rows={2}
          placeholder="Who should I talk to about raising for a fintech idea? Which investors have gone cold?"
          className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground">
            The model only sees a shortlist your database selects — every
            answer links to real contacts.
          </p>
          <Button size="sm" onClick={ask} disabled={pending || question.trim().length < 5}>
            {pending ? "Thinking…" : "Ask"}
          </Button>
        </div>
      </div>

      {result && "error" in result && (
        <p className="text-xs text-destructive">{result.error}</p>
      )}
      {result && !("error" in result) && (
        <div className="space-y-3 rounded-md border border-border p-3">
          <p className="text-[13px] leading-relaxed">{result.summary}</p>
          {result.picks.length > 0 && (
            <ol className="space-y-2">
              {result.picks.map((p, i) => (
                <li key={p.contactId} className="flex gap-2.5">
                  <span className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                    {i + 1}.
                  </span>
                  <div className="min-w-0">
                    <Link
                      href={`/contacts/${p.contactId}`}
                      className="text-[13px] font-medium hover:text-primary"
                    >
                      {p.name}
                    </Link>
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {[p.title, p.company].filter(Boolean).join(" · ")}
                    </span>
                    <p className="text-xs text-muted-foreground">{p.reason}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className="border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
            {result.candidateCount} contact profiles were shared with the model
            — {SOURCE_LABEL[result.source]}. Both calls are in the audit log
            below.
          </p>
        </div>
      )}
    </section>
  );
}
