"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Briefcase, X } from "lucide-react";

import { ContactAvatar } from "@/components/contact-avatar";
import { OpenersDialog } from "@/components/openers-dialog";
import { Button } from "@/components/ui/button";
import { changeAge } from "@/lib/digest/network-updates";
import { actOnChangeAction, dismissChangeAction } from "@/server/changes";
import type { OpenChange } from "@/server/today-data";

// "Reason to reach out" cards (SPEC §5): job/title changes detected by
// imports, with log-interaction, dismiss, and — when AI is configured —
// openers grounded in the detected change (SPEC §11).
//
// The diff reads as a diff: the old role struck through in muted text, the
// new one in the success colour, age on the right. That's what makes the
// row scannable — you see *what moved* before you read either value.
export function TodayChanges({
  items,
  now,
  aiEnabled = false,
}: {
  items: OpenChange[];
  /** Passed in from the server render so the age labels don't hydrate
   * against a different clock than the one that produced the HTML. */
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
      {items.map((c) => (
        <li
          key={c.id}
          className="flex items-center gap-3 rounded-md border border-primary/25 bg-accent/30 px-3 py-2"
        >
          <Briefcase className="size-3.5 shrink-0 text-primary" />
          <ContactAvatar
            contactId={c.contactId}
            name={c.contactName}
            hasPhoto={c.contactHasPhoto}
            size="sm"
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Link
              href={`/contacts/${c.contactId}`}
              className="truncate text-[13px] font-medium hover:underline"
            >
              {c.contactName}
            </Link>
            <span className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
              {/* An absent old value means the field was empty before, so
                  there is nothing to strike through — only news. */}
              {c.oldValue ? (
                <span className="truncate text-muted-foreground line-through decoration-muted-foreground/60">
                  {c.oldValue}
                </span>
              ) : null}
              <span className="truncate font-medium text-success">
                {c.newValue ?? "—"}
              </span>
              <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                {c.field}
              </span>
            </span>
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {changeAge(c.detectedAt, now)}
          </span>
          {aiEnabled && (
            <OpenersDialog
              contactId={c.contactId}
              changeId={c.id}
              label="Openers"
            />
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            className="h-7 text-[11px]"
            onClick={() => run(() => actOnChangeAction(c.id))}
          >
            Log interaction
          </Button>
          <button
            aria-label="Dismiss change"
            disabled={pending}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => run(() => dismissChangeAction(c.id))}
          >
            <X className="size-3.5" />
          </button>
        </li>
      ))}
    </ol>
  );
}
