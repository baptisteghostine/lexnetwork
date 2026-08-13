"use client";

import { useTransition } from "react";
import {
  Bell,
  Calendar,
  Handshake,
  Mail,
  MessageSquare,
  Trash2,
} from "lucide-react";

import { NoteEditor } from "@/components/note-editor";
import { Button } from "@/components/ui/button";
import { createNoteAction, deleteInteractionAction } from "@/server/notes";
import type { TimelineItem } from "@/server/queries";

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
  return (
    <span className="text-[11px] text-muted-foreground">
      {new Date(at).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })}
    </span>
  );
}

export function Timeline({
  items,
  newestNoteId,
}: {
  items: TimelineItem[];
  newestNoteId: number | null;
}) {
  const [pending, startTransition] = useTransition();
  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">
        No notes or interactions yet.
      </p>
    );
  }
  return (
    <ol className="space-y-2">
      {items.map((item) =>
        item.type === "note" ? (
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
            )}
          </li>
        ) : (
          <li
            key={`i${item.interaction.id}`}
            className="group flex items-center gap-2.5 rounded-md border border-border/60 px-3 py-2"
          >
            <span className="text-muted-foreground">
              {KIND_ICON[item.interaction.kind] ?? KIND_ICON.manual}
            </span>
            <span className="text-[13px] font-medium">
              {KIND_LABEL[item.interaction.kind] ?? item.interaction.kind}
            </span>
            {item.interaction.title ? (
              <span className="truncate text-[13px] text-muted-foreground">
                {item.interaction.title}
              </span>
            ) : null}
            <span className="flex-1" />
            <When at={item.at} />
            {item.interaction.source === "user" && (
              <button
                aria-label="Delete interaction"
                className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
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
  );
}
