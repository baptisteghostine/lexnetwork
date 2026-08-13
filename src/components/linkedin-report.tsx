"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, MessageSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { linkConversationAction } from "@/server/changes";
import { acceptConflictAction } from "@/server/imports";
import type { LinkedInReport } from "@/server/linkedin-import";

export function LinkedInReportView({
  runId,
  report,
}: {
  runId: number;
  report: LinkedInReport;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [accepted, setAccepted] = useState<Set<string>>(new Set());

  const s = report.stats;
  return (
    <div className="max-w-3xl space-y-6 px-5 py-4">
      <div className="flex gap-5 text-[13px]">
        {(
          [
            ["connections", s.total, ""],
            ["new", s.new, "text-success"],
            ["updated", s.updated, ""],
            ["unchanged", s.unchanged, "text-muted-foreground"],
            ["job changes", report.jobChanges.length, "text-primary"],
            ["conflicts", s.conflicts, s.conflicts ? "text-warning" : ""],
            ["messages linked", report.messagesLinked, ""],
            ["errors", s.errors, s.errors ? "text-destructive" : ""],
          ] as const
        ).map(([label, n, cls]) => (
          <div key={label}>
            <div className={`text-lg font-semibold tabular-nums ${cls}`}>{n}</div>
            <div className="text-[11px] text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>

      {report.jobChanges.length > 0 && (
        <section className="space-y-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-primary">
            Job changes — reasons to reach out
          </h2>
          <ul className="space-y-1">
            {report.jobChanges.map((c, i) => (
              <li
                key={i}
                className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-[13px]"
              >
                <Link
                  href={`/contacts/${c.contactId}`}
                  className="font-medium hover:underline"
                >
                  {c.displayName}
                </Link>
                <span className="text-[11px] uppercase text-muted-foreground">
                  {c.field}
                </span>
                <span className="text-muted-foreground">{c.old}</span>
                <ArrowRight className="size-3 text-muted-foreground" />
                <span className="font-medium">{c.new}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.conflicts.length > 0 && (
        <section className="space-y-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-warning">
            Conflicts — your edits kept, incoming shown
          </h2>
          <ul className="space-y-1">
            {report.conflicts.map((c, i) => {
              const key = `${c.contactId}:${c.field}`;
              const done = accepted.has(key);
              return (
                <li
                  key={i}
                  className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-[13px]"
                >
                  <Link
                    href={`/contacts/${c.contactId}`}
                    className="font-medium hover:underline"
                  >
                    {c.displayName}
                  </Link>
                  <span className="text-[11px] uppercase text-muted-foreground">
                    {c.field}
                  </span>
                  <span>{c.stored}</span>
                  <ArrowRight className="size-3 text-muted-foreground" />
                  <span className="text-muted-foreground">{c.incoming}</span>
                  <span className="flex-1" />
                  {done ? (
                    <span className="flex items-center gap-1 text-[11px] text-success">
                      <Check className="size-3" /> accepted
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          const res = await acceptConflictAction({
                            runId,
                            contactId: c.contactId,
                            field: c.field as
                              | "first_name"
                              | "last_name"
                              | "company"
                              | "title",
                            value: c.incoming,
                          });
                          if (!res.error) {
                            setAccepted((prev) => new Set(prev).add(key));
                            router.refresh();
                          }
                        })
                      }
                    >
                      Accept incoming
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {report.unmatched.length > 0 && (
        <section className="space-y-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Unmatched conversations — link them to contacts
          </h2>
          <ul className="space-y-1">
            {report.unmatched.map((u) => (
              <UnmatchedRow key={u.conversationId} runId={runId} convo={u} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function UnmatchedRow({
  runId,
  convo,
}: {
  runId: number;
  convo: LinkedInReport["unmatched"][number];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ id: number; name: string }[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const mySeq = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          results: { id: number; name: string }[];
        };
        if (mySeq === seq.current) setHits(data.results.slice(0, 5));
      } catch {
        // ignore
      }
    }, 150);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <li className="rounded-md border border-border/60 px-3 py-2 text-[13px]">
      <div className="flex items-center gap-2">
        <MessageSquare className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{convo.counterpartName}</span>
        <span className="text-[11px] text-muted-foreground">
          {convo.messages.length} message{convo.messages.length > 1 ? "s" : ""}
        </span>
        <span className="flex-1" />
        <div className="relative">
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value.trim()) {
                seq.current++;
                setHits([]);
              }
            }}
            placeholder="Link to contact…"
            className="h-7 w-52 text-[12px]"
          />
          {hits.length > 0 && (
            <div className="absolute right-0 z-10 mt-1 w-52 rounded-md border border-border bg-popover p-1 shadow-md">
              {hits.map((h) => (
                <button
                  key={h.id}
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await linkConversationAction(
                        runId,
                        convo.conversationId,
                        h.id
                      );
                      if (!res.error) router.refresh();
                    })
                  }
                  className="block w-full rounded px-2 py-1 text-left text-[12px] hover:bg-accent"
                >
                  {h.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
