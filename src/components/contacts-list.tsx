"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  CircleAlert,
  Clock,
  Globe,
  Sparkles,
  Star,
  Tag,
} from "lucide-react";

import { GitHubIcon, LinkedInIcon, XIcon } from "@/components/brand-icons";
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
import { changeAge } from "@/lib/digest/network-updates";
import { suggestTagsAction } from "@/server/ai";
import { bulkSetCadenceAction, setCadenceAction } from "@/server/cadence";
import {
  bulkAddTagAction,
  bulkSetArchivedAction,
  updateContactFieldAction,
} from "@/server/contacts";
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
  lastInteractionAt: number | null;
  links: { platform: string; url: string }[];
  tags: { id: number; name: string; color: string }[];
};

/**
 * Notion-style cell: reads as text, and clicking it puts a real input in
 * the same spot. Commit on Enter or blur, cancel on Escape. The saved
 * value is kept locally so the row reads correctly before the server
 * round-trip refreshes the page.
 */
function EditableCell({
  value,
  width,
  save,
  label,
}: {
  value: string | null;
  width: string;
  save: (next: string) => Promise<void>;
  label: string;
}) {
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState(value);
  const [draft, setDraft] = useState("");
  const committed = useRef(false);

  const commit = async () => {
    if (committed.current) return; // Enter already committed; blur follows
    committed.current = true;
    setEditing(false);
    const next = draft.trim();
    if (next === (current ?? "")) return;
    setCurrent(next || null); // optimistic — the refresh confirms it
    await save(next);
  };

  if (editing) {
    return (
      <input
        autoFocus
        aria-label={label}
        defaultValue={current ?? ""}
        onFocus={(e) => {
          committed.current = false;
          setDraft(e.target.value);
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") {
            committed.current = true;
            setEditing(false);
          }
        }}
        className={cn(
          width,
          "rounded border border-primary bg-background px-1 py-0.5 text-[13px] outline-none ring-2 ring-primary/20"
        )}
      />
    );
  }
  return (
    <button
      type="button"
      aria-label={`Edit ${label}`}
      onClick={() => setEditing(true)}
      className={cn(
        width,
        "cursor-text truncate rounded border border-transparent px-1 py-0.5 text-left text-[13px] hover:border-border",
        current ? "text-muted-foreground" : "text-muted-foreground/40"
      )}
    >
      {current ?? "—"}
    </button>
  );
}

/** The frequency cell doubles as its own picker (Dex: "Set frequency"
 * lives in the row, not behind an edit screen). */
function CadenceCell({
  contactId,
  cadenceDays,
  onDone,
}: {
  contactId: number;
  cadenceDays: number | null;
  onDone: () => void;
}) {
  const label =
    cadenceDays !== null
      ? (CADENCE_PRESETS.find((p) => p.days === cadenceDays)?.label ??
        `${cadenceDays}d`)
      : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "w-24 truncate rounded border border-transparent px-1 py-0.5 text-left text-[12px] hover:border-border",
            label ? "text-muted-foreground" : "text-muted-foreground/40"
          )}
        >
          {label ?? "Set frequency"}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Keep in touch</DropdownMenuLabel>
        {CADENCE_PRESETS.map((p) => (
          <DropdownMenuItem
            key={p.days}
            onSelect={() =>
              void setCadenceAction(contactId, p.days).then(onDone)
            }
          >
            {p.label}
          </DropdownMenuItem>
        ))}
        {cadenceDays !== null && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                void setCadenceAction(contactId, null).then(onDone)
              }
            >
              Remove cadence
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const LINK_ICON: Record<string, React.ReactNode> = {
  linkedin: <LinkedInIcon className="size-3" />,
  twitter: <XIcon className="size-2.5" />,
  github: <GitHubIcon className="size-3" />,
};

export function ContactsList({
  rows,
  allTags,
  archivedView,
  aiEnabled = false,
  now,
}: {
  rows: ContactRow[];
  allTags: { id: number; name: string; color: string }[];
  archivedView: boolean;
  aiEnabled?: boolean;
  /** Server clock, so relative ages match what the server rendered. */
  now: number;
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

  const saveField =
    (contactId: number, field: "title" | "company") =>
    async (value: string) => {
      await updateContactFieldAction({ contactId, field, value });
      router.refresh();
    };

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
        <span className="min-w-0 flex-1 pl-9 md:w-56 md:flex-none">Name</span>
        <span className="hidden w-44 px-1 md:block">Title</span>
        <span className="hidden w-40 px-1 lg:block">Company</span>
        <span className="hidden flex-1 lg:block">Tags</span>
        <span className="hidden w-16 md:block">Links</span>
        <span className="hidden w-20 text-right sm:block">Last touch</span>
        <span className="hidden w-24 pl-1 sm:block">Frequency</span>
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
            <span className="flex min-w-0 flex-1 items-center gap-1.5 md:w-56 md:flex-none">
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
            <EditableCell
              value={c.title}
              width="hidden md:block w-44"
              label={`title of ${c.displayName}`}
              save={saveField(c.id, "title")}
            />
            <EditableCell
              value={c.company}
              width="hidden lg:block w-40"
              label={`company of ${c.displayName}`}
              save={saveField(c.id, "company")}
            />
            <span className="hidden flex-1 gap-1 overflow-hidden lg:flex">
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
            <span className="hidden w-16 items-center gap-1 md:flex">
              {c.links.slice(0, 3).map((l) => (
                <a
                  key={l.url}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  title={l.url.replace(/^https?:\/\/(www\.)?/, "")}
                  className="flex size-5 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-primary"
                >
                  {LINK_ICON[l.platform] ?? <Globe className="size-3" />}
                </a>
              ))}
            </span>
            <span className="hidden w-20 text-right text-[11px] text-muted-foreground sm:block">
              {c.lastInteractionAt !== null
                ? changeAge(c.lastInteractionAt, now)
                : ""}
            </span>
            <span className="hidden w-24 pl-1 sm:block">
              <CadenceCell
                contactId={c.id}
                cadenceDays={c.cadenceDays}
                onDone={() => router.refresh()}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
