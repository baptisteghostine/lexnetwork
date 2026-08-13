"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Clock } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { CADENCE_PRESETS } from "@/lib/cadence/engine";
import { setCadenceAction, snoozeContactAction } from "@/server/cadence";

export function CadenceControl({
  contactId,
  cadenceDays,
  nextTouchAt,
  snoozedUntil,
}: {
  contactId: number;
  cadenceDays: number | null;
  nextTouchAt: number | null;
  snoozedUntil: number | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [customOpen, setCustomOpen] = useState(false);
  const [customDays, setCustomDays] = useState("");

  const preset = CADENCE_PRESETS.find((p) => p.days === cadenceDays);
  const label =
    cadenceDays === null
      ? "No cadence"
      : (preset?.label ?? `Every ${cadenceDays}d`);

  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      router.refresh();
    });

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={pending}>
            <Clock />
            {label}
            {nextTouchAt !== null && (
              <span className="text-muted-foreground">
                · due {new Date(nextTouchAt).toLocaleDateString()}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Keep in touch</DropdownMenuLabel>
          {CADENCE_PRESETS.map((p) => (
            <DropdownMenuItem
              key={p.days}
              onSelect={() => run(() => setCadenceAction(contactId, p.days))}
            >
              {p.label}
              {cadenceDays === p.days ? " ✓" : ""}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => setCustomOpen(true)}>
            Custom…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {cadenceDays !== null && (
            <>
              <DropdownMenuLabel>Snooze</DropdownMenuLabel>
              {(
                [
                  ["+1 day", "1d"],
                  ["+3 days", "3d"],
                  ["+1 week", "1w"],
                  ["+1 month", "1m"],
                ] as const
              ).map(([l, p]) => (
                <DropdownMenuItem
                  key={p}
                  onSelect={() => run(() => snoozeContactAction(contactId, p))}
                >
                  {l}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => run(() => setCadenceAction(contactId, null))}
              >
                Remove cadence
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* recompute clears consumed snoozes, so non-null means still active */}
      {snoozedUntil !== null && (
        <span className="text-[11px] text-muted-foreground">
          snoozed → {new Date(snoozedUntil).toLocaleDateString()}
        </span>
      )}
      {customOpen && (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const days = Number(customDays);
            if (Number.isInteger(days) && days >= 1) {
              run(() => setCadenceAction(contactId, days));
              setCustomOpen(false);
              setCustomDays("");
            }
          }}
        >
          <Input
            autoFocus
            type="number"
            min={1}
            max={3650}
            value={customDays}
            onChange={(e) => setCustomDays(e.target.value)}
            placeholder="days"
            className="h-7 w-20 text-[12px]"
            onKeyDown={(e) => e.key === "Escape" && setCustomOpen(false)}
          />
          <Button size="sm" type="submit">
            Set
          </Button>
        </form>
      )}
    </div>
  );
}
