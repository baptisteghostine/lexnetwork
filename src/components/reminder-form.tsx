"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createReminderAction } from "@/server/reminders";

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

export function ReminderForm({
  defaultContact,
}: {
  defaultContact?: ContactHit | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [recurrence, setRecurrence] = useState<string>("");
  const [customRrule, setCustomRrule] = useState("");
  const [contact, setContact] = useState<ContactHit | null>(
    defaultContact ?? null
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
          const res = await createReminderAction({}, fd);
          if (res.error) {
            setError(res.error);
            return;
          }
          setError(null);
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
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Date</Label>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
            className="w-36"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Time</Label>
          <Input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="w-28"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Repeats</Label>
          <select
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value)}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-[13px]"
          >
            {RECURRENCE.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" size="sm" disabled={pending || !title || !date}>
          {pending ? "Adding…" : "Add reminder"}
        </Button>
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
            className="max-w-xs"
          />
        )}
        {!contact && contactHits.length > 0 && (
          <div className="absolute z-10 mt-1 w-full max-w-xs rounded-md border border-border bg-popover p-1 shadow-md">
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
