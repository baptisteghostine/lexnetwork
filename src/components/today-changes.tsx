"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Briefcase, Check, Copy, X } from "lucide-react";

import { ContactAvatar } from "@/components/contact-avatar";
import { OpenersDialog } from "@/components/openers-dialog";
import { Button } from "@/components/ui/button";
import { TRIAGE_KIND_LABEL } from "@/lib/ai/triage";
import { changeAge } from "@/lib/digest/network-updates";
import {
  actOnChangeAction,
  dismissAllChangesAction,
  dismissChangeAction,
} from "@/server/changes";
import type { OpenChange } from "@/server/today-data";

// "Reason to reach out" cards (SPEC §5): job/title changes detected by
// imports, with log-interaction, dismiss, and — when AI is configured —
// openers grounded in the detected change (SPEC §11).
//
// The diff reads as a diff: the old role struck through in muted text, the
// new one in the success colour, age on the right. That's what makes the
// row scannable — you see *what moved* before you read either value.
const CHANGES_VISIBLE = 20;

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
  const [showAll, setShowAll] = useState(false);
  const [showLow, setShowLow] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      router.refresh();
    });
  // Triage (SPEC §5/§11) folds renames and headline tweaks away; the
  // owner can unfold them, never lose them. A backlog (an import that
  // read everyone differently, weeks away) must not push the rest of
  // Today off the screen either: show a screenful, offer the rest.
  const signal = items.filter((c) => !c.lowSignal);
  const low = items.filter((c) => c.lowSignal);
  const listed = showLow ? [...signal, ...low] : signal;
  const visible = showAll ? listed : listed.slice(0, CHANGES_VISIBLE);

  return (
    <div className="space-y-1">
      {(items.length > 1 || low.length > 0) && (
        <div className="flex flex-wrap justify-end gap-3">
          {low.length > 0 && (
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setShowLow((v) => !v)}
            >
              {showLow ? "Hide low-signal" : `${low.length} low-signal hidden`}
            </button>
          )}
          {listed.length > CHANGES_VISIBLE && (
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? `Show first ${CHANGES_VISIBLE}` : `Show all ${listed.length}`}
            </button>
          )}
          <button
            type="button"
            disabled={pending}
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => run(() => dismissAllChangesAction())}
          >
            Dismiss all
          </button>
        </div>
      )}
      <ol className="space-y-1">
      {visible.map((c) => (
        <li
          key={c.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-primary/25 bg-accent/30 px-3 py-2 md:flex-nowrap"
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
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px] md:flex-nowrap">
              {/* An absent old value means the field was empty before, so
                  there is nothing to strike through — only news. */}
              {c.oldValue ? (
                <span className="min-w-0 text-muted-foreground line-through decoration-muted-foreground/60 md:truncate">
                  {c.oldValue}
                </span>
              ) : null}
              <span className="min-w-0 font-medium text-success md:truncate">
                {c.newValue ?? "—"}
              </span>
              <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                {c.field}
              </span>
              {c.triage ? (
                <span className="shrink-0 rounded bg-primary/10 px-1 py-px text-[10px] font-semibold text-primary">
                  {TRIAGE_KIND_LABEL[c.triage.kind]}
                </span>
              ) : null}
            </span>
            {c.triage?.reason ? (
              <span className="text-[12px] text-muted-foreground">{c.triage.reason}</span>
            ) : null}
            {c.triage?.opener ? (
              <span className="flex items-start gap-1.5 rounded-md border border-border/60 bg-background/60 px-2 py-1 text-[12px] leading-relaxed">
                <span className="min-w-0 flex-1">{c.triage.opener}</span>
                <button
                  type="button"
                  aria-label="Copy opener"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={async () => {
                    await navigator.clipboard.writeText(c.triage!.opener);
                    setCopied(c.id);
                    setTimeout(() => setCopied(null), 1500);
                  }}
                >
                  {copied === c.id ? (
                    <Check className="size-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </button>
              </span>
            ) : null}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {changeAge(c.detectedAt, now)}
          </span>
          <span className="flex basis-full items-center justify-end gap-2 md:basis-auto">
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
          </span>
        </li>
      ))}
      </ol>
    </div>
  );
}
