"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, Check, Pencil, Repeat, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ReminderForm } from "@/components/reminder-form";
import { DAY_MS } from "@/lib/cadence/engine";
import {
  completeReminderAction,
  deleteReminderAction,
  snoozeReminderAction,
  type ReminderListRow,
} from "@/server/reminders";
import { cn } from "@/lib/utils";
import { useFormatDate } from "@/components/timezone-context";

type FormatDate = ReturnType<typeof useFormatDate>;

function dueLabel(effectiveDueAt: number, now: number, fmt: FormatDate): string {
  const days = Math.floor((now - effectiveDueAt) / DAY_MS);
  if (days > 0) return `${days}d overdue`;
  return fmt(effectiveDueAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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
  const fmt = useFormatDate();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // One row at a time turns into the reminder form (owner request
  // 2026-09-26: reminders were create-and-delete only).
  const [editingId, setEditingId] = useState<number | null>(null);
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
      {rows.map((r) =>
        editingId === r.id ? (
          <li key={r.id}>
            <ReminderForm
              initial={{
                id: r.id,
                title: r.title,
                dueAt: r.dueAt,
                rrule: r.rrule,
                lockRecurrence: r.isOccurrence,
                contact:
                  r.contactId && r.contactName
                    ? { id: r.contactId, name: r.contactName }
                    : null,
              }}
              onDone={() => setEditingId(null)}
            />
          </li>
        ) : (
        <li
          key={r.id}
          className="group flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md border border-border/60 px-3 py-2 md:flex-nowrap"
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
            <span className="block text-[13px] font-medium md:truncate">
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
          <span className="flex basis-full items-center justify-end gap-1 md:basis-auto md:gap-2.5">
            <span
              className={cn(
                "text-[11px] tabular-nums",
                kind === "due" && now - r.effectiveDueAt >= DAY_MS
                  ? "font-medium text-overdue"
                  : "text-muted-foreground"
              )}
            >
              {kind === "recurring"
                ? `next ${fmt(r.effectiveDueAt, { month: "short", day: "numeric" })}`
                : dueLabel(r.effectiveDueAt, now, fmt)}
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
              aria-label="Edit reminder"
              className="text-muted-foreground transition-opacity hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
              disabled={pending}
              onClick={() => setEditingId(r.id)}
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              aria-label="Delete reminder"
              className="text-muted-foreground transition-opacity hover:text-destructive md:opacity-0 md:group-hover:opacity-100"
              disabled={pending}
              onClick={() => run(() => deleteReminderAction(r.id))}
            >
              <Trash2 className="size-3.5" />
            </button>
          </span>
        </li>
        )
      )}
    </ul>
  );
}
