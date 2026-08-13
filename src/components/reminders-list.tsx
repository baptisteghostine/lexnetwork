"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, Check, Repeat, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DAY_MS } from "@/lib/cadence/engine";
import {
  completeReminderAction,
  deleteReminderAction,
  snoozeReminderAction,
  type ReminderListRow,
} from "@/server/reminders";
import { cn } from "@/lib/utils";

function dueLabel(effectiveDueAt: number, now: number): string {
  const days = Math.floor((now - effectiveDueAt) / DAY_MS);
  if (days > 0) return `${days}d overdue`;
  return new Date(effectiveDueAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function RemindersList({
  rows,
  now,
  kind,
}: {
  rows: ReminderListRow[];
  now: number;
  kind: "due" | "upcoming" | "recurring";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      router.refresh();
    });

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
        {kind === "due"
          ? "Nothing due — clear."
          : kind === "upcoming"
            ? "No upcoming reminders."
            : "No recurring rules yet."}
      </p>
    );
  }

  return (
    <ul className="space-y-1">
      {rows.map((r) => (
        <li
          key={r.id}
          className="group flex items-center gap-2.5 rounded-md border border-border/60 px-3 py-2"
        >
          {kind === "recurring" ? (
            <Repeat className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Bell
              className={cn(
                "size-3.5 shrink-0",
                kind === "due" ? "text-overdue" : "text-muted-foreground"
              )}
            />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">
              {r.title}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {[
                r.contactName && r.contactId
                  ? undefined // rendered as a link below
                  : null,
                r.rruleText,
                r.isOccurrence && kind !== "recurring" ? "recurring" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              {r.contactName && r.contactId ? (
                <>
                  {r.rruleText || (r.isOccurrence && kind !== "recurring")
                    ? " · "
                    : ""}
                  <Link
                    href={`/contacts/${r.contactId}`}
                    className="hover:underline"
                  >
                    {r.contactName}
                  </Link>
                </>
              ) : null}
            </span>
          </span>
          <span
            className={cn(
              "text-[11px] tabular-nums",
              kind === "due" && now - r.effectiveDueAt >= DAY_MS
                ? "font-medium text-overdue"
                : "text-muted-foreground"
            )}
          >
            {kind === "recurring"
              ? `next ${new Date(r.effectiveDueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
              : dueLabel(r.effectiveDueAt, now)}
          </span>
          {kind !== "recurring" && (
            <>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Complete"
                disabled={pending}
                className="size-7 p-0 text-muted-foreground hover:text-success"
                onClick={() => run(() => completeReminderAction(r.id))}
              >
                <Check className="size-4" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    className="h-7 px-2 text-[11px] text-muted-foreground"
                  >
                    Snooze
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {(
                    [
                      ["Tomorrow", 1],
                      ["In 3 days", 3],
                      ["Next week", 7],
                    ] as const
                  ).map(([label, days]) => (
                    <DropdownMenuItem
                      key={days}
                      onSelect={() =>
                        run(() =>
                          snoozeReminderAction(r.id, Date.now() + days * DAY_MS)
                        )
                      }
                    >
                      {label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
          <button
            aria-label="Delete reminder"
            className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            disabled={pending}
            onClick={() => run(() => deleteReminderAction(r.id))}
          >
            <Trash2 className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}
