"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  approveAgentCallAction,
  rejectAgentCallAction,
  undoAgentCallAction,
  type OwnerActionResult,
} from "@/server/agent/owner-actions";

// The agent activity page's rows (SPEC §14): what Claude changed in Rolo,
// each with a way to take it back, and — in review mode — what it wants
// to change, each with a yes and a no.

export type ActivityEntry = {
  id: number;
  status: string;
  summary: string;
  error: string | null;
  contactId: number | null;
  contactName: string | null;
  at: string;
  undone: boolean;
  undoable: boolean;
  details: { label: string; value: string }[];
};

const STATUS_LABEL: Record<string, { text: string; className: string }> = {
  queued: { text: "Waiting", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  rejected: { text: "Rejected", className: "bg-muted text-muted-foreground" },
  refused: { text: "Not applied", className: "bg-muted text-muted-foreground" },
  error: { text: "Failed", className: "bg-red-500/15 text-red-700 dark:text-red-400" },
};

function Row({ entry }: { entry: ActivityEntry }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<OwnerActionResult | null>(null);
  const run = (action: (id: number) => Promise<OwnerActionResult>) =>
    start(async () => setResult(await action(entry.id)));
  const badge = entry.undone
    ? { text: "Undone", className: "bg-muted text-muted-foreground" }
    : STATUS_LABEL[entry.status];
  return (
    <li className="px-5 py-3" data-testid="agent-activity-row">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className={`text-[13px] ${entry.undone || entry.status === "rejected" ? "text-muted-foreground line-through" : "font-medium"}`}>
            {entry.summary}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {entry.at}
            {entry.contactId && entry.contactName ? (
              <>
                {" · "}
                <Link href={`/contacts/${entry.contactId}`} className="underline-offset-2 hover:text-foreground hover:underline">
                  {entry.contactName}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {badge ? (
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.className}`}>{badge.text}</span>
          ) : null}
          {entry.status === "queued" ? (
            <>
              <Button size="sm" disabled={pending} onClick={() => run(approveAgentCallAction)}>
                {pending ? "…" : "Approve"}
              </Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(rejectAgentCallAction)}>
                Reject
              </Button>
            </>
          ) : null}
          {entry.undoable ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(undoAgentCallAction)}>
              {pending ? "…" : "Undo"}
            </Button>
          ) : null}
        </div>
      </div>
      {entry.details.length > 0 ? (
        <details className="mt-1.5 text-xs" open={entry.status === "queued"}>
          <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">
            {entry.status === "queued" ? "What it wants to write" : "Details"}
          </summary>
          <dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-md border border-border/60 bg-accent/20 px-2.5 py-2">
            {entry.details.map((d) => (
              <div key={d.label} className="contents">
                <dt className="text-muted-foreground">{d.label}</dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words">{d.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      {entry.error ? <p className="mt-1 text-xs text-muted-foreground">{entry.error}</p> : null}
      {result ? (
        <p role="status" className={`mt-1.5 text-xs ${result.ok ? "text-muted-foreground" : "text-destructive"}`}>
          {result.ok ? result.message : result.error}
        </p>
      ) : null}
    </li>
  );
}

export function AgentActivityList({ entries }: { entries: ActivityEntry[] }) {
  return (
    <ul className="divide-y divide-border">
      {entries.map((entry) => (
        <Row key={entry.id} entry={entry} />
      ))}
    </ul>
  );
}
