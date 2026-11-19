import Link from "next/link";

import { AgentActivityList } from "@/components/agent-activity-list";
import { requireAuth } from "@/lib/auth";
import { describeArgs } from "@/lib/agent/writes";
import { ownerTimezone } from "@/lib/settings";
import { formatInZone } from "@/lib/time";
import { listAgentActivity } from "@/server/agent/ledger";
import { agentWriteMode, AGENT_TOOLS } from "@/server/agent/tools";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

// Everything Claude has changed in Rolo, or wants to (SPEC §14): the
// place the owner goes to see it, take it back, or say yes or no.

export default async function AgentActivityPage({
  searchParams,
}: PageProps<"/agent-activity">) {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const query = await searchParams;
  const requested = typeof query.page === "string" ? Number.parseInt(query.page, 10) : 1;
  const page = Number.isInteger(requested) && requested > 0 ? requested : 1;
  const { rows, total, queued } = listAgentActivity(PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const zone = ownerTimezone();
  const mode = agentWriteMode();
  const titles = new Map(AGENT_TOOLS.map((t) => [t.name, t.title]));
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">
          Claude&apos;s activity
          {queued > 0 ? (
            <span data-testid="agent-queued-count" className="ml-2 text-xs font-normal text-amber-600 dark:text-amber-400">
              {queued} waiting for you
            </span>
          ) : null}
        </h1>
        <Link
          href="/settings?tab=connector"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Connector settings
        </Link>
      </header>
      <p className="border-b border-border px-5 py-2 text-xs text-muted-foreground">
        {mode === "review"
          ? "Claude's changes wait here until you approve them."
          : "What Claude has added to Rolo. Each change can be undone; undo leaves alone anything you have edited since."}
      </p>
      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-xs text-muted-foreground">
          Nothing yet. When Claude logs an exchange, writes a note or adds a person, it shows up here.
        </p>
      ) : (
        <AgentActivityList
          entries={rows.map((r) => ({
            id: r.id,
            status: r.status,
            summary:
              r.status === "queued" || r.status === "rejected" || !r.summary
                ? `${titles.get(r.tool) ?? r.tool}${r.contactName ? ` — ${r.contactName}` : ""}`
                : r.summary,
            error: r.status === "rejected" ? null : r.error,
            contactId: r.contactId,
            contactName: r.contactName,
            at: formatInZone(zone, r.createdAt, {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            }),
            undone: r.undoneAt !== null,
            undoable: r.undoable,
            details: r.tool === "undo_agent_action" ? [] : describeArgs(r.argsJson),
          }))}
        />
      )}
      {pages > 1 ? (
        <nav className="flex items-center justify-between border-t border-border px-5 py-2.5 text-xs text-muted-foreground">
          {page > 1 ? (
            <Link href={`/agent-activity?page=${page - 1}`} className="hover:text-foreground">
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span>
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link href={`/agent-activity?page=${page + 1}`} className="hover:text-foreground">
              Older →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
