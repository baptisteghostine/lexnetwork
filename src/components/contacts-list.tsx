"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Star } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CADENCE_PRESETS } from "@/lib/cadence/engine";
import { bulkSetCadenceAction } from "@/server/cadence";
import { cn } from "@/lib/utils";

export type ContactRow = {
  id: number;
  displayName: string;
  title: string | null;
  company: string | null;
  starred: boolean;
  cadenceDays: number | null;
  tags: { id: number; name: string; color: string }[];
};

export function ContactsList({ rows }: { rows: ContactRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, startTransition] = useTransition();

  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const applyCadence = (days: number | null) =>
    startTransition(async () => {
      await bulkSetCadenceAction([...selected], days);
      setSelected(new Set());
      router.refresh();
    });

  return (
    <div>
      {selected.size > 0 && (
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-5 py-1.5 text-[12px]">
          <span className="text-muted-foreground">
            {selected.size} selected — set cadence:
          </span>
          {CADENCE_PRESETS.map((p) => (
            <Button
              key={p.days}
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => applyCadence(p.days)}
            >
              {p.label}
            </Button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => applyCadence(null)}
          >
            Remove
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      <ul>
        {rows.map((c) => (
          <li
            key={c.id}
            className={cn(
              "flex items-center gap-3 border-b border-border/60 px-5 py-2 transition-colors hover:bg-accent/50",
              selected.has(c.id) && "bg-accent/40"
            )}
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-foreground"
              checked={selected.has(c.id)}
              onChange={() => toggle(c.id)}
            />
            {c.starred ? (
              <Star className="size-3 shrink-0 fill-yellow-500 text-yellow-500" />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <Link
              href={`/contacts/${c.id}`}
              className="w-56 truncate text-[13px] font-medium hover:underline"
            >
              {c.displayName}
            </Link>
            <span className="w-44 truncate text-[13px] text-muted-foreground">
              {c.title}
            </span>
            <span className="w-44 truncate text-[13px] text-muted-foreground">
              {c.company}
            </span>
            <span className="flex flex-1 gap-1 overflow-hidden">
              {c.tags.map((t) => (
                <Badge
                  key={t.id}
                  variant="outline"
                  className="shrink-0"
                  style={{ borderColor: t.color, color: t.color }}
                >
                  {t.name}
                </Badge>
              ))}
            </span>
            {c.cadenceDays !== null && (
              <span className="text-[10px] text-muted-foreground">
                {CADENCE_PRESETS.find((p) => p.days === c.cadenceDays)?.label ??
                  `${c.cadenceDays}d`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
