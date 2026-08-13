"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { Paperclip, Trash2 } from "lucide-react";

import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { activeTrigger, mentionMarkdown } from "@/lib/notes/mentions";
import {
  deleteNoteAction,
  setNoteCountsForTouchAction,
} from "@/server/notes";
import { cn } from "@/lib/utils";

type AttachmentInfo = {
  id: number;
  filename: string;
  mime: string;
  url: string;
  isImage: boolean;
};

type MentionResult = { id: number; label: string; detail: string };

export function NoteEditor({
  noteId,
  initialBody,
  countsForTouch,
  attachments,
  createdAt,
  startInEdit,
}: {
  noteId: number;
  initialBody: string;
  countsForTouch: boolean;
  attachments: AttachmentInfo[];
  createdAt: number;
  startInEdit: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState(initialBody);
  const [editing, setEditing] = useState(startInEdit);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">(
    "saved"
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Optimistic — flips immediately, server action confirms via revalidation.
  const [counts, setCounts] = useState(countsForTouch);
  const [pending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestBody = useRef(body);
  const dirty = useRef(false);

  // --- mention autocomplete state ---
  const [mentionResults, setMentionResults] = useState<MentionResult[]>([]);
  const [mentionKind, setMentionKind] = useState<"contact" | "group">(
    "contact"
  );
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  // Guards against out-of-order autocomplete responses: a slow response for
  // an older (broader) query must not overwrite results for the latest one.
  const mentionRequestSeq = useRef(0);

  const save = useCallback(
    async (text: string, keepalive = false) => {
      setSaveState("saving");
      try {
        const res = await fetch(`/api/notes/${noteId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bodyMd: text }),
          keepalive,
        });
        if (!res.ok) throw new Error(String(res.status));
        dirty.current = false;
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    },
    [noteId]
  );

  const scheduleSave = useCallback(
    (text: string) => {
      latestBody.current = text;
      dirty.current = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => save(text), 800);
    },
    [save]
  );

  // Flush pending save when the tab hides or unloads (SPEC §2 autosave).
  useEffect(() => {
    const flush = () => {
      if (dirty.current) {
        void save(latestBody.current, true);
      }
    };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", flush);
      flush();
    };
  }, [save]);

  const onChange = (text: string, caret: number) => {
    setBody(text);
    scheduleSave(text);
    const trigger = activeTrigger(text, caret);
    if (trigger && trigger.query.length >= 1) {
      const kind = trigger.sigil === "@" ? "contact" : "group";
      setMentionKind(kind);
      setMentionStart(trigger.start);
      const seq = ++mentionRequestSeq.current;
      fetch(
        `/api/mention-search?kind=${kind}&q=${encodeURIComponent(trigger.query)}`
      )
        .then((r) => r.json())
        .then((d: { results?: MentionResult[] }) => {
          if (seq !== mentionRequestSeq.current) return; // stale response
          setMentionResults(d.results ?? []);
          setMentionIndex(0);
        })
        .catch(() => {
          if (seq === mentionRequestSeq.current) setMentionResults([]);
        });
    } else {
      mentionRequestSeq.current++;
      setMentionStart(null);
      setMentionResults([]);
    }
  };

  const insertMention = (r: MentionResult) => {
    const ta = textareaRef.current;
    if (!ta || mentionStart === null) return;
    const caret = ta.selectionStart;
    const snippet = mentionMarkdown({
      kind: mentionKind,
      id: r.id,
      label: r.label,
    });
    const next = body.slice(0, mentionStart) + snippet + " " + body.slice(caret);
    setBody(next);
    scheduleSave(next);
    setMentionStart(null);
    setMentionResults([]);
    requestAnimationFrame(() => {
      const pos = mentionStart + snippet.length + 1;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  const uploadFiles = async (files: FileList | File[]) => {
    const ta = textareaRef.current;
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.set("noteId", String(noteId));
      fd.set("file", file);
      const res = await fetch("/api/attachments", { method: "POST", body: fd });
      if (!res.ok) continue;
      const info = (await res.json()) as AttachmentInfo;
      const snippet = info.isImage
        ? `\n![${info.filename}](${info.url})\n`
        : `\n[${info.filename}](${info.url})\n`;
      const caret = ta ? ta.selectionStart : body.length;
      const next = body.slice(0, caret) + snippet + body.slice(caret);
      setBody(next);
      scheduleSave(next);
    }
    router.refresh();
  };

  const created = new Date(createdAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="group rounded-md border border-border bg-card/50 p-3">
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>Note · {created}</span>
        <label className="flex cursor-pointer items-center gap-1">
          <input
            type="checkbox"
            className="h-3 w-3 accent-foreground"
            checked={counts}
            onChange={(e) => {
              const next = e.target.checked;
              setCounts(next);
              startTransition(() =>
                setNoteCountsForTouchAction(noteId, next)
              );
            }}
          />
          counts as interaction
        </label>
        <span className="flex-1" />
        <span
          className={cn(
            "transition-opacity",
            saveState === "saved" && "opacity-0 group-focus-within:opacity-60",
            saveState === "error" && "text-destructive opacity-100"
          )}
        >
          {saveState === "saving"
            ? "saving…"
            : saveState === "error"
              ? "save failed — retrying on next edit"
              : "saved"}
        </span>
        {editing ? (
          <>
            <label className="cursor-pointer hover:text-foreground">
              <Paperclip className="size-3.5" />
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => e.target.files && uploadFiles(e.target.files)}
              />
            </label>
            <button
              className="hover:text-foreground"
              onClick={() => {
                if (debounceRef.current) clearTimeout(debounceRef.current);
                void save(latestBody.current);
                setEditing(false);
              }}
            >
              Done
            </button>
          </>
        ) : (
          <button
            className="opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        )}
        <button
          className="opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          onClick={() => setConfirmDelete(true)}
          aria-label="Delete note"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {editing ? (
        <div className="relative">
          <textarea
            ref={textareaRef}
            autoFocus={startInEdit}
            value={body}
            rows={Math.max(3, body.split("\n").length + 1)}
            placeholder="Write a note… @ mentions a contact, # mentions a group. Drop or paste images."
            className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 font-mono text-[12.5px] leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
            onKeyDown={(e) => {
              if (mentionResults.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % mentionResults.length);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIndex(
                    (i) =>
                      (i - 1 + mentionResults.length) % mentionResults.length
                  );
                } else if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  insertMention(mentionResults[mentionIndex]);
                } else if (e.key === "Escape") {
                  setMentionResults([]);
                  setMentionStart(null);
                }
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length) {
                e.preventDefault();
                void uploadFiles(files);
              }
            }}
            onDrop={(e) => {
              if (e.dataTransfer.files.length) {
                e.preventDefault();
                void uploadFiles(e.dataTransfer.files);
              }
            }}
          />
          {mentionResults.length > 0 && (
            <ul className="absolute left-2 z-10 mt-1 w-72 overflow-hidden rounded-md border border-border bg-popover shadow-md">
              {mentionResults.map((r, i) => (
                <li key={r.id}>
                  <button
                    className={cn(
                      "flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-[13px]",
                      i === mentionIndex && "bg-accent"
                    )}
                    onMouseEnter={() => setMentionIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      insertMention(r);
                    }}
                  >
                    <span className="font-medium">{r.label}</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {r.detail}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {body.trim() ? (
            <div className="mt-2 border-t border-border/60 pt-2">
              <Markdown>{body}</Markdown>
            </div>
          ) : null}
        </div>
      ) : (
        <div onDoubleClick={() => setEditing(true)}>
          {body.trim() ? (
            <Markdown>{body}</Markdown>
          ) : (
            <p className="text-[12px] italic text-muted-foreground">
              Empty note
            </p>
          )}
        </div>
      )}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this note?</DialogTitle>
            <DialogDescription>
              {attachments.length > 0
                ? `Its ${attachments.length} attachment(s) will be deleted too: ${attachments.map((a) => a.filename).join(", ")}`
                : "This can't be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await deleteNoteAction(noteId);
                  setConfirmDelete(false);
                })
              }
            >
              Delete note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
