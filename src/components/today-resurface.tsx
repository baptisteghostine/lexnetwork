"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Briefcase, RotateCcw, Star, X } from "lucide-react";

import { ContactAvatar } from "@/components/contact-avatar";
import { DraftDialog } from "@/components/draft-dialog";
import { Button } from "@/components/ui/button";
import { ago } from "@/lib/prep/build";
import { dismissResurfaceAction, reachedOutAction } from "@/server/resurface-actions";
import type { ResurfacePick } from "@/server/resurface";

// "Worth reconnecting" (SPEC §3): a few people a day with real history,
// no cadence, and a long silence. Reads as a suggestion, not a queue —
// so the row makes its case in one line and offers two exits.
export function TodayResurface({
  items,
  now,
  aiEnabled = false,
}: {
  items: ResurfacePick[];
  now: number;
  aiEnabled?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      router.refresh();
    });

  return (
    <ol className="space-y-1">
      {items.map((p) => {
        const role = [p.title, p.company].filter(Boolean).join(", ");
        return (
          <li
            key={p.contactId}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 px-3 py-2 md:flex-nowrap"
          >
            <RotateCcw className="size-3.5 shrink-0 text-muted-foreground" />
            <ContactAvatar
              contactId={p.contactId}
              name={p.displayName}
              hasPhoto={p.hasPhoto}
              size="sm"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 flex-wrap items-center gap-1.5 md:flex-nowrap">
                <Link
                  href={`/contacts/${p.contactId}`}
                  className="min-w-0 text-[13px] font-medium hover:underline md:truncate"
                >
                  {p.displayName}
                </Link>
                {p.starred ? <Star className="size-3 shrink-0 fill-warning text-warning" /> : null}
                {p.hasOpenChange ? (
                  <Briefcase className="size-3 shrink-0 text-primary" aria-label="Recent job change" />
                ) : null}
                {role ? (
                  <span className="min-w-0 text-[11px] text-muted-foreground md:truncate">{role}</span>
                ) : null}
              </span>
              <span className="text-[12px] text-muted-foreground md:truncate">
                {p.lastInteractionAt ? `last spoke ${ago(p.lastInteractionAt, now)}` : "never spoke"} ·{" "}
                {p.interactionCount} interaction{p.interactionCount === 1 ? "" : "s"}
              </span>
            </span>
            <span className="flex basis-full items-center justify-end gap-2 md:basis-auto">
              {aiEnabled && <DraftDialog contactId={p.contactId} label="Draft" />}
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                className="h-7 text-[11px]"
                onClick={() => run(() => reachedOutAction(p.contactId))}
              >
                Reached out
              </Button>
              <button
                aria-label="Not now"
                title="Not now — comes round again in a few months"
                disabled={pending}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => run(() => dismissResurfaceAction(p.contactId))}
              >
                <X className="size-3.5" />
              </button>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
