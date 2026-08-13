"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { snoozeContactAction, snoozeAllAction } from "@/server/cadence";
import { createNoteAction, logInteractionAction } from "@/server/notes";
import { cn } from "@/lib/utils";

export type DueItem = {
  contactId: number;
  displayName: string;
  company: string | null;
  title: string | null;
  starred: boolean;
  daysOverdue: number;
  primaryEmail: string | null;
};

type Mode =
  | { kind: "idle" }
  | { kind: "snooze"; contactId: number }
  | { kind: "log"; contactId: number };

export function TodayQueue({ items }: { items: DueItem[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [logTitle, setLogTitle] = useState("");
  const [pending, startTransition] = useTransition();
  const listRef = useRef<HTMLOListElement>(null);
  const logInputRef = useRef<HTMLInputElement>(null);

  const current = items[Math.min(selected, items.length - 1)];

  const dispatch = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      setMode({ kind: "idle" });
      setLogTitle("");
      router.refresh();
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA";

      if (mode.kind === "snooze") {
        const presets: Record<string, "1d" | "3d" | "1w" | "1m"> = {
          "1": "1d",
          "3": "3d",
          "7": "1w",
          m: "1m",
        };
        if (presets[e.key]) {
          e.preventDefault();
          dispatch(() => snoozeContactAction(mode.contactId, presets[e.key]));
        } else if (e.key === "Escape") {
          setMode({ kind: "idle" });
        }
        return;
      }
      if (mode.kind === "log") {
        if (e.key === "Escape") setMode({ kind: "idle" });
        return; // Enter handled by the inline form
      }
      if (inField || !current) return;

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          setSelected((s) => Math.min(s + 1, items.length - 1));
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          setSelected((s) => Math.max(s - 1, 0));
          break;
        case "Enter":
          router.push(`/contacts/${current.contactId}`);
          break;
        case "l":
          e.preventDefault();
          setMode({ kind: "log", contactId: current.contactId });
          requestAnimationFrame(() => logInputRef.current?.focus());
          break;
        case "s":
          e.preventDefault();
          setMode({ kind: "snooze", contactId: current.contactId });
          break;
        case "n":
          e.preventDefault();
          startTransition(async () => {
            await createNoteAction(current.contactId);
            router.push(`/contacts/${current.contactId}`);
          });
          break;
        case "o":
          if (current.primaryEmail) {
            window.open(
              `https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(current.primaryEmail)}`,
              "_blank"
            );
          }
          break;
        case "d":
          e.preventDefault();
          dispatch(() => snoozeContactAction(current.contactId, "1d"));
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, current, items.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (items.length === 0) {
    return (
      <p className="py-10 text-center text-xs text-muted-foreground">
        Nobody is due. Set cadences on contacts to build your queue.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">
          j/k move · Enter open · <b>l</b>og · <b>s</b>nooze · <b>n</b>ote ·{" "}
          <b>o</b>pen Gmail · <b>d</b>ismiss to tomorrow
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => dispatch(() => snoozeAllAction())}
        >
          Snooze all ({items.length})
        </Button>
      </div>
      <ol ref={listRef} className="space-y-1">
        {items.map((item, i) => (
          <li
            key={item.contactId}
            data-index={i}
            onClick={() => setSelected(i)}
            className={cn(
              "flex cursor-default items-center gap-3 rounded-md border px-3 py-2",
              i === selected
                ? "border-foreground/40 bg-accent/60"
                : "border-border/60"
            )}
          >
            {item.starred ? (
              <Star className="size-3 shrink-0 fill-yellow-500 text-yellow-500" />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <span className="w-52 truncate text-[13px] font-medium">
              {item.displayName}
            </span>
            <span className="flex-1 truncate text-[12px] text-muted-foreground">
              {[item.title, item.company].filter(Boolean).join(" · ")}
            </span>
            <span
              className={cn(
                "text-[11px]",
                item.daysOverdue > 7 ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {item.daysOverdue === 0
                ? "due today"
                : `${item.daysOverdue}d overdue`}
            </span>

            {mode.kind === "snooze" && mode.contactId === item.contactId && (
              <span className="rounded bg-popover px-2 py-0.5 text-[11px]">
                snooze: <b>1</b>d · <b>3</b>d · <b>7</b>d · <b>m</b>onth · esc
              </span>
            )}
            {mode.kind === "log" && mode.contactId === item.contactId && (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  dispatch(() =>
                    logInteractionAction(item.contactId, {
                      kind: "manual",
                      title: logTitle.trim(),
                      occurredAt: Date.now(),
                    })
                  );
                }}
              >
                <Input
                  ref={logInputRef}
                  value={logTitle}
                  onChange={(e) => setLogTitle(e.target.value)}
                  placeholder="what happened? (optional) — Enter to log"
                  className="h-6 w-64 text-[11px]"
                />
              </form>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
