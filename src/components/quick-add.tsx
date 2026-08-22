"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { quickLogAction } from "@/server/quick-add";
import { cn } from "@/lib/utils";

// "Who did you meet?" (SPEC §2 amendment, Dex's capture pattern): global
// `q` or the sidebar button → find-or-create the person, one line, when
// → counting interaction, clock advanced. Capture must be cheaper than
// forgetting.

type Match = { id: number; label: string; detail: string };

function todayLocalISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function QuickAdd() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [picked, setPicked] = useState<{ id: number | null; label: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(todayLocalISO());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const searchRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  // Global hotkey — mirrors the Today queue's single-letter style.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "q") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Contact search, debounced against the mention-search endpoint the
  // note editor already uses.
  useEffect(() => {
    if (!open || picked) return;
    const q = query.trim();
    const t = setTimeout(async () => {
      if (q.length === 0) {
        setMatches([]);
        return;
      }
      const res = await fetch(`/api/mention-search?q=${encodeURIComponent(q)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { results: Match[] };
      setMatches(data.results.slice(0, 6));
      setHighlight(0);
    }, 150);
    return () => clearTimeout(t);
  }, [query, open, picked]);

  const reset = useCallback(() => {
    setQuery("");
    setMatches([]);
    setPicked(null);
    setTitle("");
    setDate(todayLocalISO());
    setError(null);
  }, []);

  const options: { id: number | null; label: string; detail: string }[] = [
    ...matches.map((m) => ({ id: m.id as number | null, label: m.label, detail: m.detail })),
    ...(query.trim().length > 1
      ? [{ id: null, label: query.trim(), detail: "Create new contact" }]
      : []),
  ];

  const pick = (o: { id: number | null; label: string }) => {
    setPicked({ id: o.id, label: o.label });
    setMatches([]);
    requestAnimationFrame(() => noteRef.current?.focus());
  };

  const submit = () => {
    if (!picked || title.trim().length === 0) {
      setError("Pick a person and say what happened.");
      return;
    }
    // Noon local time: stable across timezones, never "yesterday".
    const occurredAt = new Date(`${date}T12:00:00`).getTime();
    start(async () => {
      const result = await quickLogAction({
        ...(picked.id !== null
          ? { contactId: picked.id }
          : { newContactName: picked.label }),
        title: title.trim(),
        occurredAt,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
      reset();
      router.refresh();
    });
  };

  return (
    <>
      <div className="px-2 pb-1">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start text-muted-foreground"
          onClick={() => setOpen(true)}
        >
          <Plus className="size-3.5" />
          Log a meeting
          <kbd className="ml-auto rounded border border-border px-1 text-[10px]">q</kbd>
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Who did you meet?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {picked ? (
              <div className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5">
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  {picked.id === null && <UserPlus className="size-3.5 text-muted-foreground" />}
                  {picked.label}
                  {picked.id === null && (
                    <span className="text-[11px] font-normal text-muted-foreground">
                      new contact
                    </span>
                  )}
                </span>
                <Button variant="ghost" size="sm" onClick={() => { setPicked(null); setQuery(""); requestAnimationFrame(() => searchRef.current?.focus()); }}>
                  Change
                </Button>
              </div>
            ) : (
              <div>
                <Input
                  ref={searchRef}
                  autoFocus
                  placeholder="Search contacts or type a new name…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setHighlight((h) => Math.min(h + 1, options.length - 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setHighlight((h) => Math.max(h - 1, 0));
                    } else if (e.key === "Enter" && options.length > 0) {
                      e.preventDefault();
                      pick(options[Math.min(highlight, options.length - 1)]);
                    }
                  }}
                />
                {options.length > 0 && (
                  <ul className="mt-1 overflow-hidden rounded-md border border-border">
                    {options.map((o, i) => (
                      <li key={`${o.id}-${o.label}`}>
                        <button
                          type="button"
                          onClick={() => pick(o)}
                          onMouseEnter={() => setHighlight(i)}
                          className={cn(
                            "flex w-full items-baseline justify-between px-2.5 py-1.5 text-left text-[13px]",
                            i === highlight ? "bg-accent" : "bg-background"
                          )}
                        >
                          <span className="flex items-center gap-1.5 truncate">
                            {o.id === null && <UserPlus className="size-3.5 text-muted-foreground" />}
                            {o.label}
                          </span>
                          <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                            {o.detail}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <Input
              ref={noteRef}
              placeholder="What happened? (coffee, call, intro…)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <Input
                type="date"
                value={date}
                max={todayLocalISO()}
                onChange={(e) => setDate(e.target.value)}
                className="w-40"
              />
              <Button onClick={submit} disabled={pending}>
                {pending ? "Logging…" : "Log it"}
              </Button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <p className="text-[11px] text-muted-foreground">
              Logs a counting interaction — their keep-in-touch clock restarts
              from this date.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
