"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { summarizeNoteAction } from "@/server/ai";

// Note summarization (SPEC §11): offered only on long notes; the summary
// is stored, shown above the note, clearly labeled as AI-generated, and
// regenerable.

export function AiNoteSummary({
  noteId,
  bodyLength,
  summary,
  threshold,
}: {
  noteId: number;
  bodyLength: number;
  summary: string | null;
  threshold: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (bodyLength < threshold && !summary) return null;

  function generate() {
    start(async () => {
      const result = await summarizeNoteAction({ noteId });
      if (result.error) setError(result.error);
      else {
        setError(null);
        router.refresh();
      }
    });
  }

  return (
    <div className="mb-1.5">
      {summary ? (
        <div className="rounded-md border border-border/60 bg-accent/40 px-2.5 py-2">
          <p className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Sparkles className="size-3" /> AI summary
          </p>
          <p className="text-[13px] leading-relaxed">{summary}</p>
          <button
            className="mt-1 text-[11px] text-muted-foreground hover:text-foreground"
            disabled={pending}
            onClick={generate}
          >
            {pending ? "Summarizing…" : "Regenerate"}
          </button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px] text-muted-foreground"
          disabled={pending}
          onClick={generate}
        >
          <Sparkles className="size-3" />
          {pending ? "Summarizing…" : "Summarize with AI"}
        </Button>
      )}
      {error && <p className="text-xs text-muted-foreground">{error}</p>}
    </div>
  );
}
