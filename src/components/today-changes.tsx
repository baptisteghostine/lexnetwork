"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Briefcase, X } from "lucide-react";

import { ContactAvatar } from "@/components/contact-avatar";
import { OpenersDialog } from "@/components/openers-dialog";
import { Button } from "@/components/ui/button";
import { actOnChangeAction, dismissChangeAction } from "@/server/changes";
import type { OpenChange } from "@/server/today-data";

// "Reason to reach out" cards (SPEC §5): job/title changes detected by
// imports, with log-interaction, dismiss, and — when AI is configured —
// openers grounded in the detected change (SPEC §11).
export function TodayChanges({
  items,
  aiEnabled = false,
}: {
  items: OpenChange[];
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
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]">
            <Link
              href={`/contacts/${c.contactId}`}
              className="shrink-0 font-medium hover:underline"
            >
              {c.contactName}
            </Link>
            <span className="truncate text-muted-foreground">
              {c.oldValue ?? "—"}
            </span>
            <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{c.newValue ?? "—"}</span>
            {c.field === "title" ? (
              <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                title
              </span>
            ) : null}
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
