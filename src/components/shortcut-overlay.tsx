"use client";

import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

// `?` anywhere (outside inputs) shows the keyboard cheat sheet (SPEC §12).
const SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Anywhere",
    rows: [
      ["⌘K / Ctrl-K", "Search & commands"],
      ["/", "Search"],
      ["g then t / c / r / a / g / i / s", "Jump to Today · Contacts · Reminders · Tags · Groups · Imports · Settings"],
      ["?", "This cheat sheet"],
    ],
  },
  {
    title: "Today queue",
    rows: [
      ["j / k", "Move down / up"],
      ["Enter", "Open contact"],
      ["l", "Log interaction"],
      ["s", "Snooze (then 1 / 3 / 7 / m)"],
      ["n", "New note"],
      ["o", "Open Gmail compose"],
      ["d", "Dismiss to tomorrow"],
    ],
  },
  {
    title: "Anywhere",
    rows: [
      ["q", "Log a meeting (quick add)"],
      ["a", "Ask your network (AI)"],
    ],
  },
  {
    title: "Keep-in-touch triage",
    rows: [
      ["1 … 7", "File under that frequency"],
      ["x", "Don't keep in touch"],
      ["j / k", "Skip down / up"],
      ["u", "Undo last move"],
      ["Esc", "Leave triage"],
    ],
  },
  {
    title: "Search palette",
    rows: [
      ["↑ ↓", "Move selection"],
      ["Enter", "Open"],
      ["Esc", "Close"],
    ],
  },
];

export function ShortcutOverlay() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-5 shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <DialogPrimitive.Title className="text-sm font-semibold">
            Keyboard shortcuts
          </DialogPrimitive.Title>
          <div className="mt-3 space-y-4">
            {SECTIONS.map((s) => (
              <div key={s.title}>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {s.title}
                </p>
                <dl className="space-y-1">
                  {s.rows.map(([keys, what]) => (
                    <div
                      key={keys}
                      className="flex items-baseline justify-between gap-4 text-[12px]"
                    >
                      <dt>
                        <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px]">
                          {keys}
                        </kbd>
                      </dt>
                      <dd className="text-right text-muted-foreground">
                        {what}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[10px] text-muted-foreground">
            Esc to close
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
