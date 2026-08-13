"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Bell,
  Bookmark,
  FolderTree,
  Import,
  Search,
  Settings,
  Star,
  StickyNote,
  Sun,
  Tags,
  UserPlus,
  Users,
} from "lucide-react";

import { ContactAvatar } from "@/components/contact-avatar";

type ContactHit = {
  id: number;
  name: string;
  detail: string;
  hasPhoto: boolean;
  starred: boolean;
};

type NoteHit = {
  noteId: number;
  contactId: number;
  contactName: string;
  snippet: string;
};

// Navigation actions, also reachable directly via G-then-key chords
// (SPEC §12 keyboard-first: g t go-Today, g c go-Contacts, …).
const NAV = [
  { key: "t", label: "Go to Today", href: "/today", icon: Sun },
  { key: "c", label: "Go to Contacts", href: "/contacts", icon: Users },
  { key: "r", label: "Go to Reminders", href: "/reminders", icon: Bell },
  { key: "a", label: "Go to Tags", href: "/tags", icon: Tags },
  { key: "g", label: "Go to Groups", href: "/groups", icon: FolderTree },
  { key: "i", label: "Go to Imports", href: "/imports", icon: Import },
  { key: "s", label: "Go to Settings", href: "/settings", icon: Settings },
] as const;

const NEW_CONTACT = {
  label: "New contact",
  href: "/contacts/new",
  icon: UserPlus,
};

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [noteHits, setNoteHits] = useState<NoteHit[]>([]);
  const [savedViews, setSavedViews] = useState<{ id: number; name: string }[]>(
    []
  );
  const [active, setActive] = useState(0);
  const chordAt = useRef<number>(0);
  const requestSeq = useRef(0);

  // Global shortcuts: ⌘K / Ctrl-K toggle, "/" opens, G-then-key navigates.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (inField || open || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        setOpen(true);
        return;
      }
      const now = Date.now();
      if (now - chordAt.current < 900) {
        const nav = NAV.find((n) => n.key === e.key);
        if (nav) {
          e.preventDefault();
          chordAt.current = 0;
          router.push(nav.href);
          return;
        }
      }
      if (e.key === "g") chordAt.current = now;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, router]);

  // Saved views load once per palette open (run-a-view actions).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/views")
      .then((r) => (r.ok ? r.json() : { views: [] }))
      .then((data: { views: { id: number; name: string }[] }) => {
        if (!cancelled) setSavedViews(data.views ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Debounced contact search; sequence guard drops stale responses.
  // (Empty-query clearing happens in the change handler, not here.)
  useEffect(() => {
    const q = query.trim();
    if (!open || !q) return;
    const seq = ++requestSeq.current;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          results: ContactHit[];
          notes?: NoteHit[];
        };
        if (seq === requestSeq.current) {
          setHits(data.results);
          setNoteHits(data.notes ?? []);
          setActive(0);
        }
      } catch {
        // Network hiccup — keep previous results.
      }
    }, 120);
    return () => clearTimeout(t);
  }, [query, open]);

  const q = query.trim().toLowerCase();
  const actions = [
    NEW_CONTACT,
    ...savedViews.map((v) => ({
      label: `View: ${v.name}`,
      href: `/contacts?view=${v.id}`,
      icon: Bookmark,
    })),
    ...NAV,
  ].filter((a) => !q || a.label.toLowerCase().includes(q));
  const total = hits.length + noteHits.length + actions.length;

  const go = (index: number) => {
    setOpen(false);
    if (index < hits.length) {
      router.push(`/contacts/${hits[index].id}`);
    } else if (index < hits.length + noteHits.length) {
      router.push(`/contacts/${noteHits[index - hits.length].contactId}`);
    } else {
      const a = actions[index - hits.length - noteHits.length];
      if (a) router.push(a.href);
    }
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, total - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && total > 0) {
      e.preventDefault();
      go(active);
    }
  };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          requestSeq.current++;
          setQuery("");
          setHits([]);
          setNoteHits([]);
          setActive(0);
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-24 z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <DialogPrimitive.Title className="sr-only">
            Search and commands
          </DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!e.target.value.trim()) {
                  requestSeq.current++;
                  setHits([]);
                  setNoteHits([]);
                  setActive(0);
                }
              }}
              onKeyDown={onInputKey}
              placeholder="Search contacts or jump anywhere…"
              className="h-11 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            />
            <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
              esc
            </kbd>
          </div>
          <div className="max-h-80 overflow-y-auto p-1.5">
            {hits.length > 0 && (
              <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Contacts
              </p>
            )}
            {hits.map((c, i) => (
              <button
                key={c.id}
                onClick={() => go(i)}
                onMouseMove={() => setActive(i)}
                className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] ${
                  active === i ? "bg-accent" : ""
                }`}
              >
                <ContactAvatar
                  contactId={c.id}
                  name={c.name}
                  hasPhoto={c.hasPhoto}
                  size="sm"
                />
                <span className="truncate font-medium">{c.name}</span>
                {c.starred ? (
                  <Star className="size-3 shrink-0 fill-warning text-warning" />
                ) : null}
                <span className="flex-1 truncate text-right text-[11px] text-muted-foreground">
                  {c.detail}
                </span>
              </button>
            ))}
            {noteHits.length > 0 && (
              <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Notes
              </p>
            )}
            {noteHits.map((n, j) => {
              const i = hits.length + j;
              return (
                <button
                  key={`n${n.noteId}`}
                  onClick={() => go(i)}
                  onMouseMove={() => setActive(i)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] ${
                    active === i ? "bg-accent" : ""
                  }`}
                >
                  <StickyNote className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-muted-foreground">
                    {n.snippet}
                  </span>
                  <span className="flex-1 truncate text-right text-[11px] text-muted-foreground">
                    {n.contactName}
                  </span>
                </button>
              );
            })}
            {actions.length > 0 && (
              <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Actions
              </p>
            )}
            {actions.map((a, j) => {
              const i = hits.length + noteHits.length + j;
              const Icon = a.icon;
              return (
                <button
                  key={a.label}
                  onClick={() => go(i)}
                  onMouseMove={() => setActive(i)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] ${
                    active === i ? "bg-accent" : ""
                  }`}
                >
                  <Icon className="size-3.5 text-muted-foreground" />
                  {a.label}
                  {"key" in a ? (
                    <span className="flex-1 text-right text-[10px] text-muted-foreground">
                      g&thinsp;{a.key}
                    </span>
                  ) : null}
                </button>
              );
            })}
            {query.trim() && total === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                No matches for “{query.trim()}”.
              </p>
            ) : null}
          </div>
          <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
            ↑↓ navigate · ↵ open · ⌘K or / anywhere · g then a letter jumps
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
