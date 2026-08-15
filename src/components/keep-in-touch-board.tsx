"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Star } from "lucide-react";

import { ContactAvatar } from "@/components/contact-avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  setKeepInTouchAction,
  type BoardCard,
  type BoardColumn,
  type KeepInTouchBoard,
} from "@/server/keep-in-touch";

// Keep-in-touch board (SPEC §3a). Two ways to move people, because the
// job has two scales: drag one card when you're curating, and keyboard
// triage when you have three thousand imported contacts and no cadences.

type LastMove = {
  contactIds: number[];
  /** Where each contact came from, so undo restores exactly. */
  from: { id: number; target: number | "never" | "unset" }[];
};

function columnTargetOf(columns: BoardColumn[], card: BoardCard) {
  for (const col of columns) {
    if (col.cards.some((c) => c.id === card.id)) return col.target;
  }
  return "unset" as const;
}

export function KeepInTouchBoard({ board }: { board: KeepInTouchBoard }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [lastMove, setLastMove] = useState<LastMove | null>(null);
  const [triage, setTriage] = useState(false);
  const [cursor, setCursor] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);

  // Triage always works the Uncategorized pile — that's the column whose
  // emptying is the whole point of the board.
  const untriagedColumn = board.columns.find((c) => c.id === "unset");
  const queue = untriagedColumn?.cards ?? [];
  const current = queue[Math.min(cursor, queue.length - 1)];
  const assignable = board.columns.filter((c) => typeof c.target === "number");

  const move = useCallback(
    (contactIds: number[], target: number | "never" | "unset") => {
      const from = contactIds.map((id) => {
        const card = board.columns
          .flatMap((c) => c.cards)
          .find((c) => c.id === id);
        return {
          id,
          target: card ? columnTargetOf(board.columns, card) : ("unset" as const),
        };
      });
      startTransition(async () => {
        await setKeepInTouchAction(contactIds, target);
        setLastMove({ contactIds, from });
        router.refresh();
      });
    },
    [board.columns, router]
  );

  const undo = useCallback(() => {
    if (!lastMove) return;
    const byTarget = new Map<number | "never" | "unset", number[]>();
    for (const f of lastMove.from) {
      const list = byTarget.get(f.target) ?? [];
      list.push(f.id);
      byTarget.set(f.target, list);
    }
    startTransition(async () => {
      for (const [target, ids] of byTarget) {
        await setKeepInTouchAction(ids, target);
      }
      setLastMove(null);
      router.refresh();
    });
  }, [lastMove, router]);

  // Keyboard triage: number keys assign the focused card and advance, so a
  // few thousand contacts is an evening rather than a few thousand drags.
  useEffect(() => {
    if (!triage) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Escape") {
        setTriage(false);
        return;
      }
      if (e.key === "u") {
        e.preventDefault();
        undo();
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, queue.length - 1));
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
        return;
      }
      if (!current) return;
      if (e.key === "x") {
        e.preventDefault();
        move([current.id], "never");
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= assignable.length) {
        e.preventDefault();
        move([current.id], assignable[n - 1].target);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [triage, current, queue.length, assignable, move, undo]);

  useEffect(() => {
    if (triage) cardRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor, triage]);

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-3">
        <div>
          <h1 className="text-sm font-semibold">Keep in touch</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Set a frequency and Rolo keeps them on your radar.{" "}
            {board.untriaged > 0 ? (
              <span className="text-foreground">
                {board.untriaged.toLocaleString()} of{" "}
                {board.totalContacts.toLocaleString()} still need a decision.
              </span>
            ) : (
              <span>Everyone has been triaged.</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastMove ? (
            <Button variant="ghost" size="sm" disabled={pending} onClick={undo}>
              Undo
            </Button>
          ) : null}
          <Button
            variant={triage ? "default" : "outline"}
            size="sm"
            disabled={queue.length === 0}
            onClick={() => {
              setTriage((t) => !t);
              setCursor(0);
            }}
          >
            {triage ? "Stop triage" : "Triage by keyboard"}
          </Button>
        </div>
      </header>

      {triage && current ? (
        <div className="flex items-center gap-4 border-b border-border bg-accent/40 px-5 py-2.5">
          <ContactAvatar
            contactId={current.id}
            name={current.displayName}
            hasPhoto={current.hasPhoto}
            size="sm"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">
              {current.displayName}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {[current.title, current.company].filter(Boolean).join(" · ") ||
                "No title or company"}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {assignable.map((c, i) => (
              <span key={c.id} className="mr-2">
                <b>{i + 1}</b> {c.label.replace(/^Every /, "")}
              </span>
            ))}
            <span className="mr-2">
              <b>x</b> never
            </span>
            <span className="mr-2">
              <b>j/k</b> skip
            </span>
            <span>
              <b>u</b> undo
            </span>
          </p>
          <span className="whitespace-nowrap text-[11px] text-muted-foreground">
            {queue.length.toLocaleString()} left here
          </span>
        </div>
      ) : null}

      <div className="flex flex-1 gap-3 overflow-x-auto px-5 py-4">
        {board.columns.map((col) => (
          <section
            key={col.id}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropTarget(col.id);
            }}
            onDragLeave={() => setDropTarget((t) => (t === col.id ? null : t))}
            onDrop={(e) => {
              e.preventDefault();
              setDropTarget(null);
              // Prefer the payload the drag itself carried: React state can
              // be stale if the drop lands after a re-render, and it's the
              // only channel that survives a drag between windows.
              const dropped = Number(e.dataTransfer.getData("text/plain"));
              const id = Number.isInteger(dropped) && dropped > 0 ? dropped : dragId;
              if (id !== null) move([id], col.target);
              setDragId(null);
            }}
            className={cn(
              "flex w-56 shrink-0 flex-col rounded-lg border bg-card/40",
              dropTarget === col.id
                ? "border-primary/60 ring-1 ring-primary/30"
                : "border-border/60"
            )}
          >
            <div className="flex items-baseline justify-between border-b border-border/60 px-3 py-2">
              <h2 className="truncate text-[12px] font-medium">{col.label}</h2>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {col.total.toLocaleString()}
              </span>
            </div>
            <div className="flex-1 space-y-1 overflow-y-auto p-2">
              {col.cards.length === 0 ? (
                <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
                  No contacts with this frequency
                </p>
              ) : (
                col.cards.map((card) => {
                  const focused =
                    triage && col.id === "unset" && current?.id === card.id;
                  return (
                    <div
                      key={card.id}
                      ref={focused ? cardRef : undefined}
                      draggable
                      onDragStart={(e) => {
                        // Firefox refuses to start a drag with no payload,
                        // so this is required, not decorative.
                        e.dataTransfer.setData("text/plain", String(card.id));
                        e.dataTransfer.effectAllowed = "move";
                        setDragId(card.id);
                      }}
                      onDragEnd={() => setDragId(null)}
                      className={cn(
                        "flex cursor-grab items-center gap-2 rounded-md border px-2 py-1.5 active:cursor-grabbing",
                        focused
                          ? "border-primary/60 bg-accent ring-1 ring-primary/30"
                          : "border-border/60 bg-background",
                        dragId === card.id && "opacity-40"
                      )}
                    >
                      <ContactAvatar
                        contactId={card.id}
                        name={card.displayName}
                        hasPhoto={card.hasPhoto}
                        size="sm"
                      />
                      <Link
                        href={`/contacts/${card.id}`}
                        className="min-w-0 flex-1 truncate text-[12px] hover:underline"
                        draggable={false}
                      >
                        {card.displayName}
                      </Link>
                      {card.starred ? (
                        <Star className="size-3 shrink-0 fill-warning text-warning" />
                      ) : null}
                    </div>
                  );
                })
              )}
              {col.total > col.cards.length ? (
                <p className="px-2 py-2 text-center text-[11px] text-muted-foreground">
                  showing {col.cards.length} of {col.total.toLocaleString()}
                </p>
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
