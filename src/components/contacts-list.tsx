"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  CircleAlert,
  Clock,
  Sparkles,
  Star,
  Tag,
} from "lucide-react";

import { ContactAvatar } from "@/components/contact-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CADENCE_PRESETS } from "@/lib/cadence/engine";
import { suggestTagsAction } from "@/server/ai";
import { bulkSetCadenceAction } from "@/server/cadence";
import { bulkAddTagAction, bulkSetArchivedAction } from "@/server/contacts";
import { cn } from "@/lib/utils";

export type ContactRow = {
  id: number;
  displayName: string;
  title: string | null;
  company: string | null;
  starred: boolean;
  cadenceDays: number | null;
  hasPhoto: boolean;
  overdue: boolean;
  tags: { id: number; name: string; color: string }[];
};

export function ContactsList({
  rows,
  allTags,
  archivedView,
  aiEnabled = false,
}: {
  rows: ContactRow[];
  allTags: { id: number; name: string; color: string }[];
  archivedView: boolean;
  aiEnabled?: boolean;
}) {
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

  const allSelected = selected.size === rows.length && rows.length > 0;

  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      setSelected(new Set());
      router.refresh();
    });

  return (
    <div>
      {/* Bulk bar (Dex pattern: checkbox rows → act on the selection) */}
      {selected.size > 0 && (
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-5 py-1.5 text-[12px]">
          <span className="font-medium tabular-nums">
            {selected.size} selected
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={pending}>
                <Clock className="size-3.5" />
                Set cadence
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Keep in touch</DropdownMenuLabel>
              {CADENCE_PRESETS.map((p) => (
                <DropdownMenuItem
                  key={p.days}
                  onSelect={() =>
                    run(() => bulkSetCadenceAction([...selected], p.days))
                  }
                >
                  {p.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() =>
                  run(() => bulkSetCadenceAction([...selected], null))
                }
              >
                Remove cadence
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {aiEnabled && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  await suggestTagsAction({ contactIds: [...selected] });
                })
              }
            >
              <Sparkles className="size-3.5" />
              Suggest tags
            </Button>
          )}
          {allTags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={pending}>
                  <Tag className="size-3.5" />
                  Add tag
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {allTags.map((t) => (
                  <DropdownMenuItem
                    key={t.id}
                    onSelect={() =>
                      run(() => bulkAddTagAction([...selected], t.id))
                    }
                  >
                    <span
                      className="mr-1.5 inline-block size-2 rounded-full"
                      style={{ backgroundColor: t.color }}
                    />
                    {t.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              run(() => bulkSetArchivedAction([...selected], !archivedView))
            }
          >
            {archivedView ? (
              <ArchiveRestore className="size-3.5" />
            ) : (
              <Archive className="size-3.5" />
            )}
            {archivedView ? "Unarchive" : "Archive"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      <div className="flex items-center gap-3 border-b border-border px-5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <input
          type="checkbox"
          aria-label="Select all"
          className="h-3.5 w-3.5 accent-primary"
          checked={allSelected}
          onChange={() =>
            setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
          }
        />
        <span className="w-64 pl-9">Name</span>
        <span className="w-44">Title</span>
        <span className="w-44">Company</span>
        <span className="flex-1">Tags</span>
        <span className="w-20 text-right">Cadence</span>
      </div>
      <ul>
        {rows.map((c) => (
          <li
            key={c.id}
            className={cn(
              "flex items-center gap-3 border-b border-border/60 px-5 py-1.5 transition-colors hover:bg-accent/50",
              selected.has(c.id) && "bg-accent/40"
            )}
          >
            <input
              type="checkbox"
              aria-label={`Select ${c.displayName}`}
              className="h-3.5 w-3.5 accent-primary"
              checked={selected.has(c.id)}
              onChange={() => toggle(c.id)}
            />
            <ContactAvatar
              contactId={c.id}
              name={c.displayName}
              hasPhoto={c.hasPhoto}
              size="sm"
            />
            <span className="flex w-64 items-center gap-1.5">
              <Link
                href={`/contacts/${c.id}`}
                className="truncate text-[13px] font-medium hover:underline"
              >
                {c.displayName}
              </Link>
              {c.starred ? (
                <Star className="size-3 shrink-0 fill-warning text-warning" />
              ) : null}
              {c.overdue ? (
                <CircleAlert
                  aria-label="Keep-in-touch overdue"
                  className="size-3 shrink-0 text-overdue"
                />
              ) : null}
            </span>
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
            <span className="w-20 text-right text-[10px] text-muted-foreground">
              {c.cadenceDays !== null
                ? (CADENCE_PRESETS.find((p) => p.days === c.cadenceDays)
                    ?.label ?? `${c.cadenceDays}d`)
                : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
