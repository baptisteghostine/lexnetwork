"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserPlus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ago } from "@/lib/prep/build";
import { describeCounts } from "@/lib/suggestions/rank";
import type { OpenSuggestion } from "@/server/sync/suggestions";
import { approveSuggestionAction, dismissSuggestionAction } from "@/server/suggestions";

// "People you met" (SPEC §9f): attendees and correspondents Rolo keeps
// seeing who aren't contacts. One click adds them — with the history the
// syncs already saw — and one click says "no, that's a vendor".
export function TodaySuggestions({
  items,
  now,
  total,
  showAllLink = true,
}: {
  items: OpenSuggestion[];
  now: number;
  total: number;
  showAllLink?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      router.refresh();
    });

  return (
    <div className="space-y-2">
      <ol className="space-y-1">
        {items.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 px-3 py-2 md:flex-nowrap"
          >
            <UserPlus className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 flex-wrap items-baseline gap-1.5 md:flex-nowrap">
                <span className="min-w-0 text-[13px] font-medium md:truncate">
                  {s.name ?? s.email}
                </span>
                {s.name ? (
                  <span className="min-w-0 text-[11px] text-muted-foreground md:truncate">{s.email}</span>
                ) : null}
              </span>
              <span className="text-[12px] text-muted-foreground md:truncate">
                {describeCounts(s)} · seen {ago(s.lastSeenAt, now)}
                {s.lastTitle ? ` · “${s.lastTitle}”` : ""}
              </span>
            </span>
            <span className="flex basis-full items-center justify-end gap-2 md:basis-auto">
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                className="h-7 text-[11px]"
                onClick={() => run(() => approveSuggestionAction(s.id))}
              >
                Add to Rolo
              </Button>
              <button
                aria-label="Not a contact"
                title="Not a contact — never suggest again"
                disabled={pending}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => run(() => dismissSuggestionAction(s.id))}
              >
                <X className="size-3.5" />
              </button>
            </span>
          </li>
        ))}
      </ol>
      {showAllLink && total > items.length ? (
        <p className="text-[11px] text-muted-foreground">
          <Link href="/people-you-met" className="hover:underline">
            {total - items.length} more →
          </Link>
        </p>
      ) : null}
    </div>
  );
}
