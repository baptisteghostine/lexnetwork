"use client";

import { useState, useTransition } from "react";
import {
  Bell,
  Briefcase,
  Calendar,
  Handshake,
  Mail,
  MessageSquare,
  Trash2,
} from "lucide-react";

import { AiNoteSummary } from "@/components/ai-note-summary";
import { NoteEditor } from "@/components/note-editor";
import { bodyFromMeta } from "@/lib/imports/linkedin";
import { Button } from "@/components/ui/button";
import { createNoteAction, deleteInteractionAction } from "@/server/notes";
import type { TimelineItem } from "@/server/queries";

/** SPEC §2/§9: email rows carry an "open in Gmail" link built from the
 * stored thread id — there is no body to show, only a way back to it. */
function gmailThreadUrl(meta: string | null): string | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { threadId?: unknown };
    return typeof parsed.threadId === "string" &&
      /^[a-zA-Z0-9_-]+$/.test(parsed.threadId)
      ? `https://mail.google.com/mail/u/0/#all/${parsed.threadId}`
      : null;
  } catch {
    return null;
  }
}

export function AddNoteButton({ contactId }: { contactId: number }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await createNoteAction(contactId);
        })
      }
    >
      {pending ? "…" : "Add note"}
    </Button>
  );
}

const KIND_ICON: Record<string, React.ReactNode> = {
  email: <Mail className="size-3.5" />,
  meeting: <Calendar className="size-3.5" />,
  message: <MessageSquare className="size-3.5" />,
  manual: <Handshake className="size-3.5" />,
  reminder_fired: <Bell className="size-3.5" />,
};

const KIND_LABEL: Record<string, string> = {
  email: "Email",
  meeting: "Meeting",
  message: "Message",
  manual: "Caught up",
  reminder_fired: "Reminder",
};

function When({ at }: { at: number }) {
  const d = new Date(at);
  // Phones get "22 Aug"; the full date and time would wrap to five lines
  // in the row's last column.
  return (
    <span className="whitespace-nowrap text-[11px] text-muted-foreground">
      <span className="md:hidden">
        {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
      </span>
      <span className="hidden md:inline">
        {d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
      </span>
    </span>
  );
}

// Dex pattern: a filter control at the top of the timeline narrows to one
// activity type instantly.
const FILTERS = [
  { key: "all", label: "All" },
  { key: "notes", label: "Notes" },
  { key: "interactions", label: "Interactions" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

export function Timeline({
  items,
  newestNoteId,
  aiEnabled = false,
  summarizeThreshold = 1500,
}: {
  items: TimelineItem[];
  newestNoteId: number | null;
  aiEnabled?: boolean;
  summarizeThreshold?: number;
}) {
  const [pending, startTransition] = useTransition();
  const [filter, setFilter] = useState<FilterKey>("all");
  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">
        No notes or interactions yet. Log a catch-up or jot a note — anything
        that counts as a touch keeps this person off the overdue list.
      </p>
    );
  }
  const visible = items.filter((i) =>
    filter === "all"
      ? true
      : filter === "notes"
        ? i.type === "note"
        : // A note ticked "counts as interaction" is one (SPEC §3).
          i.type === "interaction" ||
          i.type === "change" ||
          (i.type === "note" && i.note.countsForTouch)
  );
  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
              filter === f.key
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          Nothing of this type yet.
        </p>
      ) : null}
      <ol className="space-y-2">
        {visible.map((item) =>
        item.type === "change" ? (
          <li
            key={`c${item.change.id}`}
            className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md border border-border/60 px-3 py-2 md:flex-nowrap"
          >
            <span className="text-muted-foreground">
              <Briefcase className="size-3.5" />
            </span>
            <span className="whitespace-nowrap text-[13px] font-medium capitalize">
              {item.change.field} change
            </span>
            <span className="order-last basis-full text-[13px] text-muted-foreground md:order-none md:min-w-0 md:basis-auto md:truncate">
              {item.change.oldValue ?? "—"} → {item.change.newValue ?? "—"}
            </span>
            <span className="flex-1" />
            <When at={item.at} />
          </li>
        ) : item.type === "note" ? (
          <li key={`n${item.note.id}`}>
            {item.mentionedOnly ? (
              <div className="rounded-md border border-dashed border-border p-3">
                <p className="mb-1 text-[11px] text-muted-foreground">
                  Mentioned in a note · <When at={item.at} />
                </p>
                <NoteEditor
                  noteId={item.note.id}
                  initialBody={item.note.bodyMd}
                  countsForTouch={item.note.countsForTouch}
                  attachments={item.attachments.map((a) => ({
                    id: a.id,
                    filename: a.filename,
                    mime: a.mime,
                    url: `/api/attachments/${a.id}`,
                    isImage: a.mime.startsWith("image/"),
                  }))}
                  createdAt={item.note.createdAt}
                  startInEdit={false}
                />
              </div>
            ) : (
              <>
                {aiEnabled && (
                  <AiNoteSummary
                    noteId={item.note.id}
                    bodyLength={item.note.bodyMd.length}
                    summary={item.note.summaryAi}
                    threshold={summarizeThreshold}
                  />
                )}
                <NoteEditor
                  noteId={item.note.id}
                  initialBody={item.note.bodyMd}
                  countsForTouch={item.note.countsForTouch}
                  attachments={item.attachments.map((a) => ({
                    id: a.id,
                    filename: a.filename,
                    mime: a.mime,
                    url: `/api/attachments/${a.id}`,
                    isImage: a.mime.startsWith("image/"),
                  }))}
                  createdAt={item.note.createdAt}
                  startInEdit={item.note.id === newestNoteId}
                />
              </>
            )}
          </li>
        ) : (
          <li
            key={`i${item.interaction.id}`}
            className="group flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md border border-border/60 px-3 py-2 md:flex-nowrap"
          >
            <span className="text-muted-foreground">
              {KIND_ICON[item.interaction.kind] ?? KIND_ICON.manual}
            </span>
            <span className="whitespace-nowrap text-[13px] font-medium">
              {KIND_LABEL[item.interaction.kind] ?? item.interaction.kind}
            </span>
            {item.interaction.title ? (
              <span className="order-last basis-full text-[13px] text-muted-foreground md:order-none md:min-w-0 md:basis-auto md:truncate">
                {item.interaction.title}
              </span>
            ) : null}
            {item.interaction.kind === "message" && bodyFromMeta(item.interaction.meta) && (
              <details className="order-last basis-full text-[12px]">
                <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                  Full message
                </summary>
                <p className="mt-1 whitespace-pre-wrap rounded-md border border-border/60 bg-accent/20 px-2.5 py-1.5 leading-relaxed">
                  {bodyFromMeta(item.interaction.meta)}
                </p>
              </details>
            )}
            {item.interaction.kind === "email" &&
              gmailThreadUrl(item.interaction.meta) && (
                <a
                  href={gmailThreadUrl(item.interaction.meta)!}
                  target="_blank"
                  rel="noreferrer"
                  className="order-last whitespace-nowrap text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline md:order-none"
                >
                  Open in Gmail
                </a>
              )}
            <span className="flex-1" />
            <When at={item.at} />
            {item.interaction.source === "user" && (
              <button
                aria-label="Delete interaction"
                className="text-muted-foreground transition-opacity hover:text-destructive md:opacity-0 md:group-hover:opacity-100"
                disabled={pending}
                onClick={() =>
                  startTransition(() =>
                    deleteInteractionAction(item.interaction.id)
                  )
                }
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </li>
        )
      )}
      </ol>
    </div>
  );
}
