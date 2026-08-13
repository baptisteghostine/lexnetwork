"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, Check, Repeat } from "lucide-react";

import { ContactAvatar } from "@/components/contact-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DAY_MS } from "@/lib/cadence/engine";
import type { DueReminder } from "@/server/today-data";
import {
  completeReminderAction,
  snoozeReminderAction,
} from "@/server/reminders";
import { cn } from "@/lib/utils";

export function TodayReminders({
  items,
  now,
}: {
  items: DueReminder[];
  now: number;
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
      {items.map((r) => {
        const overdueDays = Math.floor((now - r.dueAt) / DAY_MS);
        return (
          <li
            key={r.id}
            className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2"
          >
            <Bell className="size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                {r.title}
                {r.isRecurring ? (
                  <Repeat className="size-3 shrink-0 text-muted-foreground" />
                ) : null}
              </span>
              {r.contactId && r.contactName ? (
                <Link
                  href={`/contacts/${r.contactId}`}
                  className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <ContactAvatar
                    contactId={r.contactId}
                    name={r.contactName}
                    hasPhoto={r.contactHasPhoto}
                    size="sm"
                  />
                  {r.contactName}
                </Link>
              ) : null}
            </span>
            <span
              className={cn(
                "text-[11px] tabular-nums",
                overdueDays > 0
                  ? "font-medium text-overdue"
                  : "text-muted-foreground"
              )}
            >
              {overdueDays > 0 ? `${overdueDays}d overdue` : "today"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Complete reminder"
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
          </li>
        );
      })}
    </ol>
  );
}
