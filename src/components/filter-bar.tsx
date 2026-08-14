"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, ListFilter, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DAY_MS } from "@/lib/cadence/engine";
import { encodeFilterParam } from "@/lib/filters/encode";
import type { FilterClause, FilterSet } from "@/lib/filters/types";
import { createViewAction } from "@/server/views";

type NamedRef = { id: number; name: string };

// A pending text-entry state for dimensions that need typing.
type PendingInput =
  | { kind: "titleContains" }
  | { kind: "educationContains" }
  | { kind: "company"; mode: "current" | "past" | "ex" | "any" }
  | { kind: "saveView" };

const COMPANY_MODES: {
  mode: "current" | "past" | "ex" | "any";
  label: string;
}[] = [
  { mode: "current", label: "Company (current)…" },
  { mode: "past", label: "Company (past)…" },
  { mode: "ex", label: "Ex-company (worked there, left)…" },
  { mode: "any", label: "Company (current or past)…" },
];

export function FilterBar({
  filter,
  sortParam,
  warnings,
  allTags,
  allGroups,
  activeView,
}: {
  filter: FilterSet;
  sortParam: string;
  warnings: string[];
  allTags: NamedRef[];
  allGroups: NamedRef[];
  activeView: { id: number; name: string } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [input, setInput] = useState<PendingInput | null>(null);
  const [text, setText] = useState("");

  const apply = (clauses: FilterClause[]) => {
    const next: FilterSet = { v: 1, clauses };
    const suffix = sortParam ? `&sort=${sortParam}` : "";
    router.push(
      clauses.length
        ? `/contacts?f=${encodeFilterParam(next)}${suffix}`
        : `/contacts${sortParam ? `?sort=${sortParam}` : ""}`
    );
  };

  const add = (clause: FilterClause) => {
    setInput(null);
    setText("");
    // SPEC §7: OR within a dimension, AND across. A second tag/group pick
    // extends the existing clause's id list ("conference OR nyc") instead
    // of adding a second clause that would AND them into "both tags".
    if (clause.dim === "tag" || clause.dim === "group") {
      const existing = filter.clauses.findIndex((c) => c.dim === clause.dim);
      if (existing >= 0) {
        const prior = filter.clauses[existing] as { dim: "tag" | "group"; ids: number[] };
        const merged = [...new Set([...prior.ids, ...clause.ids])];
        apply(
          filter.clauses.map((c, i) =>
            i === existing ? { ...prior, ids: merged } : c
          )
        );
        return;
      }
    }
    apply([...filter.clauses, clause]);
  };

  const removeAt = (index: number) =>
    apply(filter.clauses.filter((_, i) => i !== index));

  const tagName = (id: number) =>
    allTags.find((t) => t.id === id)?.name ?? `#${id}`;
  const groupName = (id: number) =>
    allGroups.find((g) => g.id === id)?.name ?? `#${id}`;

  const chipLabel = (c: FilterClause): string => {
    switch (c.dim) {
      case "tag":
        return `Tag: ${c.ids.map(tagName).join(", ")}`;
      case "group":
        return `Group: ${c.ids.map(groupName).join(", ")}`;
      case "lastInteraction":
        return c.op === "never"
          ? "Never spoken"
          : `Last touch ${c.op} ${new Date(c.at ?? 0).toLocaleDateString()}`;
      case "titleContains":
        return `Title ~ “${c.value}”`;
      case "company":
        return `${c.mode === "ex" ? "Ex-" : ""}Company${c.mode === "past" ? " (past)" : c.mode === "any" ? " (any)" : ""}: ${c.value}`;
      case "educationContains":
        return `Education ~ “${c.value}”`;
      case "locationRadius":
        return `Within ${c.km} km`;
      case "hasLinkedin":
        return c.value ? "Has LinkedIn" : "No LinkedIn";
      case "createdAt":
        return "Added recently";
      case "starred":
        return c.value ? "Starred" : "Not starred";
      case "archived":
        return c.value ? "Archived" : "Active";
      case "cadence":
        return c.value === "set" ? "Has cadence" : "No cadence";
      case "dueStatus":
        return c.value === "due"
          ? "Due now"
          : c.value === "overdue"
            ? "Overdue"
            : "Not due";
      case "customField":
        return `Field #${c.fieldId} ${c.op} ${c.value}`;
    }
  };

  return (
    <div className="space-y-2 border-b border-border px-5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <ListFilter className="size-3.5" />
              Filter
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {allTags.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Tag</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {allTags.map((t) => (
                    <DropdownMenuItem
                      key={t.id}
                      onSelect={() => add({ dim: "tag", ids: [t.id] })}
                    >
                      {t.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {allGroups.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Group</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {allGroups.map((g) => (
                    <DropdownMenuItem
                      key={g.id}
                      onSelect={() => add({ dim: "group", ids: [g.id] })}
                    >
                      {g.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Last interaction</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {[30, 90, 180].map((d) => (
                  <DropdownMenuItem
                    key={d}
                    onSelect={() =>
                      add({
                        dim: "lastInteraction",
                        op: "before",
                        at: Date.now() - d * DAY_MS,
                      })
                    }
                  >
                    Not spoken in {d}+ days
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem
                  onSelect={() => add({ dim: "lastInteraction", op: "never" })}
                >
                  Never spoken
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {COMPANY_MODES.map((m) => (
              <DropdownMenuItem
                key={m.mode}
                onSelect={() => setInput({ kind: "company", mode: m.mode })}
              >
                {m.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onSelect={() => setInput({ kind: "titleContains" })}>
              Title contains…
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setInput({ kind: "educationContains" })}
            >
              Education contains…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => add({ dim: "starred", value: true })}>
              Starred
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => add({ dim: "dueStatus", value: "due" })}>
              Due now
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => add({ dim: "cadence", value: "set" })}>
              Has cadence
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => add({ dim: "cadence", value: "unset" })}>
              No cadence
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => add({ dim: "hasLinkedin", value: true })}
            >
              Has LinkedIn
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                add({
                  dim: "createdAt",
                  from: Date.UTC(new Date().getFullYear(), 0, 1),
                })
              }
            >
              Added this year
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] text-muted-foreground">
              Location radius needs a geocoder (not configured)
            </DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>

        {filter.clauses.map((c, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-[12px] text-accent-foreground"
          >
            {chipLabel(c)}
            <button
              aria-label="Remove filter"
              onClick={() => removeAt(i)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}

        {warnings.map((w) => (
          <span
            key={w}
            className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2.5 py-1 text-[12px] text-warning"
            title={w}
          >
            <TriangleAlert className="size-3" />
            {w}
          </span>
        ))}

        {activeView ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 px-2.5 py-1 text-[12px] text-primary">
            <Bookmark className="size-3" />
            {activeView.name}
          </span>
        ) : null}

        {filter.clauses.length > 0 && !activeView ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-[12px] text-muted-foreground"
            onClick={() => setInput({ kind: "saveView" })}
          >
            <Bookmark className="size-3.5" />
            Save as view
          </Button>
        ) : null}
      </div>

      {input ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = text.trim();
            if (!v) return;
            if (input.kind === "titleContains") {
              add({ dim: "titleContains", value: v });
            } else if (input.kind === "educationContains") {
              add({ dim: "educationContains", value: v });
            } else if (input.kind === "company") {
              add({ dim: "company", mode: input.mode, value: v });
            } else {
              startTransition(async () => {
                const res = await createViewAction({
                  name: v,
                  filterJson: JSON.stringify(filter),
                  sortJson: sortParam ? JSON.stringify({ key: sortParam, dir: "asc" }) : null,
                });
                if (res.id) {
                  setInput(null);
                  setText("");
                  router.push(`/contacts?view=${res.id}`);
                }
              });
            }
          }}
        >
          <Input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              input.kind === "saveView"
                ? "View name — e.g. Founders gone quiet"
                : input.kind === "company"
                  ? "Company name…"
                  : input.kind === "titleContains"
                    ? "Title contains…"
                    : "School / degree / field…"
            }
            className="max-w-xs"
            onKeyDown={(e) => e.key === "Escape" && setInput(null)}
          />
          <Button type="submit" size="sm" disabled={pending}>
            {input.kind === "saveView" ? "Save view" : "Apply"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setInput(null)}
          >
            Cancel
          </Button>
        </form>
      ) : null}
    </div>
  );
}
