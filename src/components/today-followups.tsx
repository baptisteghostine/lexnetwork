"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MessageSquareText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { captureFollowupAction, skipFollowupAction } from "@/server/followups";
import type { FollowupItem } from "@/server/today-data";

// "How did it go?" (SPEC §9e/§11, 2026-09-26): one line from the owner
// after a meeting becomes the note and the reminders. Dictation on a
// phone keyboard makes this voice capture with no audio pipeline.

function whenLabel(at: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

export function TodayFollowups({ items, timezone }: { items: FollowupItem[]; timezone: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState<Record<number, string>>({});
  const [message, setMessage] = useState<Record<number, string>>({});

  const save = (item: FollowupItem) =>
    start(async () => {
      const res = await captureFollowupAction({ eventId: item.id, text: text[item.id] ?? "" });
      if (res.error) {
        setMessage((m) => ({ ...m, [item.id]: res.error! }));
        return;
      }
      setMessage((m) => ({
        ...m,
        [item.id]: `Saved as a note${res.reminders ? ` with ${res.reminders} reminder${res.reminders === 1 ? "" : "s"}` : ""}.`,
      }));
      router.refresh();
    });

  return (
    <ol className="space-y-2">
      {items.map((item) => (
        <li key={item.id} className="space-y-2 rounded-md border border-border/60 px-3 py-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
            <MessageSquareText className="size-3.5 shrink-0 translate-y-0.5 text-primary" />
            <span className="font-medium">How did it go with</span>
            {item.contacts.map((c, i) => (
              <span key={c.contactId}>
                <Link href={`/contacts/${c.contactId}`} className="font-medium hover:underline">
                  {c.name}
                </Link>
                {i < item.contacts.length - 1 ? "," : "?"}
              </span>
            ))}
            <span className="text-[11px] text-muted-foreground">
              {item.summary ?? "(no title)"} · {whenLabel(item.startsAt, timezone)}
            </span>
          </div>
          <textarea
            value={text[item.id] ?? ""}
            onChange={(e) => setText((t) => ({ ...t, [item.id]: e.target.value }))}
            rows={2}
            placeholder="One line is enough: what you learned, what you promised, when to follow up…"
            className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save(item);
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={pending || !(text[item.id] ?? "").trim()} onClick={() => save(item)}>
              {pending ? "Saving…" : "Save note + reminders"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  await skipFollowupAction({ eventId: item.id });
                  router.refresh();
                })
              }
            >
              Skip
            </Button>
            {message[item.id] && <span className="text-[11px] text-muted-foreground">{message[item.id]}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
