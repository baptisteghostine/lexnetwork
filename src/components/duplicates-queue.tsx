"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GitMerge, ScanSearch, Undo2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  bulkMergeAction,
  dismissPairAction,
  scanNowAction,
  undoMergeAction,
  type ContactSummary,
  type DuplicatePair,
  type RecentMerge,
} from "@/server/dedupe";

// Bulk selection treats ≥95% (email/phone-identity matches) as high
// confidence; anything below is a similarity guess the confirm step
// calls out separately, so a fuzzy pair is a decision, not a drive-by.
const HIGH_CONFIDENCE = 0.95;

// The dedupe suggestion queue (SPEC §10): review, merge, or dismiss.
// Nothing ever auto-merges; a dismissed pair stays dismissed.

function reasonLabel(reason: string): string {
  if (reason === "email_match") return "same email";
  if (reason === "phone_match") return "same phone";
  if (reason === "same_company") return "same company";
  if (reason === "same_email_domain") return "same email domain";
  if (reason === "shared_group") return "shared group";
  if (reason.startsWith("jw:")) return `name ${reason.slice(3)}`;
  return reason;
}

function Side({ c }: { c: ContactSummary }) {
  return (
    <div className="min-w-0 flex-1">
      <Link
        href={`/contacts/${c.id}`}
        className="block truncate text-[13px] font-medium hover:text-primary"
      >
        {c.displayName}
        {c.archived && (
          <span className="ml-1 text-[11px] font-normal text-muted-foreground">
            (archived)
          </span>
        )}
      </Link>
      <p className="truncate text-xs text-muted-foreground">
        {[c.title, c.company].filter(Boolean).join(" · ") || "—"}
      </p>
      <p className="truncate text-xs text-muted-foreground">{c.email ?? ""}</p>
    </div>
  );
}

export function DuplicatesQueue({
  queue,
  recentMerges,
}: {
  queue: DuplicatePair[];
  recentMerges: RecentMerge[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const toggle = (pairId: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(pairId)) next.delete(pairId);
      else next.add(pairId);
      return next;
    });
  const chosen = queue.filter((p) => selected.has(p.id));
  const highCount = chosen.filter((p) => p.score >= HIGH_CONFIDENCE).length;
  const fuzzyCount = chosen.length - highCount;
  const exactIds = queue
    .filter((p) => p.score >= HIGH_CONFIDENCE)
    .map((p) => p.id);

  const runBulkMerge = () =>
    start(async () => {
      const result = await bulkMergeAction({ pairIds: [...selected] });
      setConfirming(false);
      setSelected(new Set());
      const skippedNote =
        result.skipped.length > 0
          ? ` · ${result.skipped.length} skipped (${result.skipped[0].reason})`
          : "";
      setMessage(
        result.error ?? `Merged ${result.merged} pair${result.merged === 1 ? "" : "s"}${skippedNote}`
      );
      router.refresh();
    });

  return (
    <div className="max-w-3xl space-y-5 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const { summary } = await scanNowAction();
              setMessage(summary);
              router.refresh();
            })
          }
        >
          <ScanSearch className="size-3.5" />
          {pending ? "Scanning…" : "Scan now"}
        </Button>
        {queue.length > 0 && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || exactIds.length === 0}
              onClick={() => setSelected(new Set(exactIds))}
            >
              Select exact matches ({exactIds.length})
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                setSelected((s) =>
                  s.size === queue.length
                    ? new Set()
                    : new Set(queue.map((p) => p.id))
                )
              }
            >
              {selected.size === queue.length ? "Select none" : "Select all"}
            </Button>
          </>
        )}
        {message && (
          <span className="text-xs text-muted-foreground">{message}</span>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-primary/40 bg-accent/40 px-3 py-2">
          {confirming ? (
            <>
              <p className="text-xs">
                Merge <b>{chosen.length}</b> pair{chosen.length === 1 ? "" : "s"}:{" "}
                {highCount} exact match{highCount === 1 ? "" : "es"}
                {fuzzyCount > 0 ? (
                  <span className="text-warning">
                    {" "}
                    and {fuzzyCount} similarity guess{fuzzyCount === 1 ? "" : "es"}
                  </span>
                ) : null}
                . The contact with more data wins each pair; everything else
                is unioned. Each merge can be undone below.
              </p>
              <Button size="sm" disabled={pending} onClick={runBulkMerge}>
                <GitMerge className="size-3.5" />
                {pending ? "Merging…" : `Merge ${chosen.length}`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setConfirming(false)}
              >
                Back
              </Button>
            </>
          ) : (
            <>
              <p className="text-xs">
                {selected.size} pair{selected.size === 1 ? "" : "s"} selected
              </p>
              <Button size="sm" onClick={() => setConfirming(true)}>
                <GitMerge className="size-3.5" />
                Merge selected…
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </Button>
            </>
          )}
        </div>
      )}

      {queue.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No duplicate suggestions. The scan runs daily — and after big
          imports it&rsquo;s worth a manual pass.
        </p>
      ) : (
        <ul className="space-y-2">
          {queue.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-3 rounded-md border border-border p-3"
            >
              <input
                type="checkbox"
                className="size-3.5 shrink-0 accent-primary"
                aria-label={`Select ${p.a.displayName} / ${p.b.displayName}`}
                checked={selected.has(p.id)}
                onChange={() => toggle(p.id)}
              />
              <Side c={p.a} />
              <Side c={p.b} />
              <div className="w-40 shrink-0">
                <p className="text-xs font-medium tabular-nums">
                  {(p.score * 100).toFixed(0)}%
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {p.reasons.map(reasonLabel).join(", ")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" asChild>
                  <Link
                    href={`/duplicates/merge?winner=${p.a.id}&loser=${p.b.id}`}
                  >
                    <GitMerge className="size-3.5" />
                    Merge…
                  </Link>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  aria-label="Not duplicates"
                  onClick={() =>
                    start(async () => {
                      await dismissPairAction({ pairId: p.id });
                      router.refresh();
                    })
                  }
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {recentMerges.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recent merges
          </h2>
          <ul className="space-y-1">
            {recentMerges.map((m) => (
              <li key={m.logId} className="flex items-center gap-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">
                    {m.loserName} →{" "}
                  </span>
                  <Link
                    href={`/contacts/${m.winnerId}`}
                    className="font-medium hover:text-primary"
                  >
                    {m.winnerName}
                  </Link>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const result = await undoMergeAction({ logId: m.logId });
                      setMessage(result.error ?? "Merge undone.");
                      router.refresh();
                    })
                  }
                >
                  <Undo2 className="size-3.5" />
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
