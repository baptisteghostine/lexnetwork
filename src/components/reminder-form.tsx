"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createReminderAction,
  updateReminderAction,
} from "@/server/reminders";

const RECURRENCE = [
  { value: "", label: "One-off" },
  { value: "FREQ=DAILY", label: "Daily" },
  { value: "FREQ=WEEKLY", label: "Weekly" },
  { value: "FREQ=WEEKLY;INTERVAL=2", label: "Every 2 weeks" },
  { value: "FREQ=MONTHLY", label: "Monthly" },
  { value: "FREQ=YEARLY", label: "Yearly" },
  { value: "custom", label: "Custom RRULE…" },
] as const;

type ContactHit = { id: number; name: string };

/** An existing reminder to edit in place — the form then saves instead of creating. */
export type ReminderInitial = {
  id: number;
  title: string;
  dueAt: number;
  rrule: string | null;
  /** Occurrences of a series cannot become rules of their own. */
  lockRecurrence: boolean;
  contact: ContactHit | null;
};

const pad = (n: number) => String(n).padStart(2, "0");
function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ReminderForm({
  defaultContact,
  initial,
  onDone,
}: {
  defaultContact?: ContactHit | null;
  initial?: ReminderInitial;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [date, setDate] = useState(() => {
    if (initial) return localDate(new Date(initial.dueAt));
    // Today, in the browser's local date — an empty date input renders as a
    // blank box on iPhone with no hint of what it is.
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [time, setTime] = useState(() =>
    initial ? localTime(new Date(initial.dueAt)) : ""
  );
  const [recurrence, setRecurrence] = useState<string>(() => {
    const r = initial?.rrule ?? "";
    if (!r) return "";
    return RECURRENCE.some((o) => o.value === r) ? r : "custom";
  });
  const [customRrule, setCustomRrule] = useState(initial?.rrule ?? "");
  const [contact, setContact] = useState<ContactHit | null>(
    initial ? initial.contact : (defaultContact ?? null)
  );
  const [contactQuery, setContactQuery] = useState("");
  const [contactHits, setContactHits] = useState<ContactHit[]>([]);
  const seq = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const q = contactQuery.trim();
    if (!q) return;
    const mySeq = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { results: ContactHit[] };
        if (mySeq === seq.current) setContactHits(data.results.slice(0, 5));
      } catch {
        // ignore network hiccups
      }
    }, 150);
    return () => clearTimeout(t);
  }, [contactQuery]);

  const rrule = recurrence === "custom" ? customRrule : recurrence;

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        const dueAt = new Date(`${date}T${time || "09:00"}`).getTime();
        const fd = new FormData();
        fd.set(
          "payload",
          JSON.stringify({
            title,
            dueAt,
            rrule,
            contactId: contact?.id ?? null,
          })
        );
        startTransition(async () => {
          const res = initial
            ? await updateReminderAction(initial.id, fd)
            : await createReminderAction({}, fd);
          if (res.error) {
            setError(res.error);
            return;
          }
          setError(null);
          if (initial) {
            router.refresh();
            onDone?.();
            return;
          }
          setTitle("");
          setContact(null);
          setContactQuery("");
          setContactHits([]);
          router.refresh();
        });
      }}
      className="space-y-3 rounded-md border border-border bg-card/40 p-3"
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1 space-y-1">
          <Label className="text-[11px] text-muted-foreground">Reminder</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Follow up about the intro…"
            required
          />
        </div>
        <div className="flex-1 space-y-1 sm:flex-none">
          <Label className="text-[11px] text-muted-foreground">Date</Label>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
            className="w-full sm:w-36"
          />
        </div>
        <div className="flex-1 space-y-1 sm:flex-none">
          <Label className="text-[11px] text-muted-foreground">Time</Label>
          <Input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="w-full sm:w-28"
          />
        </div>
        {!initial?.lockRecurrence && (
        <div className="flex-1 space-y-1 sm:flex-none">
          <Label className="text-[11px] text-muted-foreground">Repeats</Label>
          <select
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-[13px] sm:w-auto"
          >
            {RECURRENCE.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        )}
        <Button type="submit" size="sm" disabled={pending || !title || !date} className="basis-full sm:basis-auto">
          {initial ? (pending ? "Saving…" : "Save") : pending ? "Adding…" : "Add reminder"}
        </Button>
        {initial && onDone ? (
          <Button type="button" variant="ghost" size="sm" onClick={onDone} className="basis-full sm:basis-auto">
            Cancel
          </Button>
        ) : null}
      </div>

      {recurrence === "custom" && (
        <Input
          value={customRrule}
          onChange={(e) => setCustomRrule(e.target.value)}
          placeholder="FREQ=MONTHLY;BYDAY=2TU (2nd Tuesday monthly)"
          className="font-mono text-[12px]"
        />
      )}

      <div className="relative">
        {contact ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[12px]">
            For {contact.name}
            <button
              type="button"
              aria-label="Detach contact"
              onClick={() => setContact(null)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        ) : (
          <Input
            value={contactQuery}
            onChange={(e) => {
              setContactQuery(e.target.value);
              if (!e.target.value.trim()) {
                seq.current++;
                setContactHits([]);
              }
            }}
            placeholder="Attach a contact (optional) — type to search"
            className="sm:max-w-xs"
          />
        )}
        {!contact && contactHits.length > 0 && (
          <div className="absolute z-10 mt-1 w-full rounded-md sm:max-w-xs border border-border bg-popover p-1 shadow-md">
            {contactHits.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setContact(c);
                  setContactQuery("");
                  setContactHits([]);
                }}
                className="block w-full rounded px-2 py-1 text-left text-[13px] hover:bg-accent"
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
