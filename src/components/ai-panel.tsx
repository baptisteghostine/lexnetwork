"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Sparkles, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  resolveSuggestionsAction,
  suggestTagsAction,
  type AiCallRow,
  type SuggestionRow,
} from "@/server/ai";

// The AI review surface (SPEC §11): the tag-suggestion queue — nothing
// applies without approval — and the audit trail of every model call.

function timeAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function AiPanel({
  enabled,
  suggestions,
  audit,
}: {
  enabled: boolean;
  suggestions: SuggestionRow[];
  audit: {
    calls: AiCallRow[];
    totals: { calls: number; inputTokens: number; outputTokens: number };
  };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const resolve = (ids: number[], approve: boolean) =>
    start(async () => {
      await resolveSuggestionsAction({ ids, approve });
      router.refresh();
    });

  return (
    <div className="max-w-3xl space-y-6 px-5 py-4">
      {enabled && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Auto-tagging
          </h2>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const result = await suggestTagsAction({ allUntagged: true });
                  setMessage(
                    result.error ??
                      `Queued tag suggestions for ${result.queued} untagged contact${result.queued === 1 ? "" : "s"} — they'll appear below within a minute.`
                  );
                  router.refresh();
                })
              }
            >
              <Sparkles className="size-3.5" />
              Suggest tags for all untagged
            </Button>
            <span className="text-xs text-muted-foreground">
              Or select contacts on the Contacts page and use &ldquo;Suggest
              tags&rdquo;.
            </span>
          </div>
          {message && (
            <p className="text-xs text-muted-foreground">{message}</p>
          )}
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Suggestions to review
          </h2>
          {suggestions.length > 1 && (
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  resolve(
                    suggestions.map((s) => s.id),
                    true
                  )
                }
              >
                Approve all
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  resolve(
                    suggestions.map((s) => s.id),
                    false
                  )
                }
              >
                Reject all
              </Button>
            </div>
          )}
        </div>
        {suggestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing waiting for review.
          </p>
        ) : (
          <ul className="space-y-1">
            {suggestions.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2"
              >
                <Link
                  href={`/contacts/${s.contactId}`}
                  className="w-40 shrink-0 truncate text-[13px] font-medium hover:text-primary"
                >
                  {s.contactName}
                </Link>
                <Badge variant="outline" className="shrink-0">
                  {s.tagName}
                </Badge>
                {s.isNewTag && (
                  <span className="shrink-0 rounded bg-primary/10 px-1 py-px text-[10px] font-semibold text-primary">
                    new tag
                  </span>
                )}
                <span
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                  title={s.rationale}
                >
                  {s.rationale}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {(s.confidence * 100).toFixed(0)}%
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5"
                  aria-label="Approve"
                  disabled={pending}
                  onClick={() => resolve([s.id], true)}
                >
                  <Check className="size-3.5 text-emerald-500" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5"
                  aria-label="Reject"
                  disabled={pending}
                  onClick={() => resolve([s.id], false)}
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Audit — {audit.totals.calls} call{audit.totals.calls === 1 ? "" : "s"},{" "}
          {audit.totals.inputTokens.toLocaleString()} in /{" "}
          {audit.totals.outputTokens.toLocaleString()} out tokens
        </h2>
        {audit.calls.length === 0 ? (
          <p className="text-sm text-muted-foreground">No AI calls yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {audit.calls.map((c) => (
              <li key={c.id} className="rounded-md border border-border/60">
                <button
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
                  onClick={() =>
                    setExpanded((cur) => (cur === c.id ? null : c.id))
                  }
                >
                  <span
                    className={
                      c.status === "success"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400"
                    }
                  >
                    {c.status}
                  </span>
                  <span className="font-medium">{c.feature}</span>
                  <span className="text-muted-foreground">{c.model}</span>
                  <span className="flex-1" />
                  <span className="tabular-nums text-muted-foreground">
                    {c.inputTokens ?? "—"} / {c.outputTokens ?? "—"} tok ·{" "}
                    {c.latencyMs ?? "—"}ms · {timeAgo(c.createdAt)}
                  </span>
                </button>
                {expanded === c.id && (
                  <div className="space-y-1 border-t border-border/60 px-2.5 py-1.5 text-[11px]">
                    {c.error && (
                      <p className="text-red-600 dark:text-red-400">
                        {c.error}
                      </p>
                    )}
                    <p className="whitespace-pre-wrap break-words text-muted-foreground">
                      {c.promptPreview}
                      {c.promptPreview.length >= 400 ? "…" : ""}
                    </p>
                    {c.responsePreview && (
                      <p className="whitespace-pre-wrap break-words">
                        {c.responsePreview}
                        {c.responsePreview.length >= 400 ? "…" : ""}
                      </p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
