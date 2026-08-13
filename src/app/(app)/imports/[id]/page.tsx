import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";

import { ConflictList } from "@/components/conflict-list";
import { StatsRow } from "@/components/import-flow";
import { LinkedInReportView } from "@/components/linkedin-report";
import { db } from "@/db/client";
import { syncRuns } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import type { ImportStats, RowPlan } from "@/lib/imports/types";
import type { LinkedInReport } from "@/server/linkedin-import";

export const dynamic = "force-dynamic";

export default async function ImportReportPage({
  params,
}: PageProps<"/imports/[id]">) {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const { id } = await params;
  const run = db
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.id, Number(id)))
    .get();
  if (!run) notFound();

  // LinkedIn runs store a structured report, CSV/vCard runs a plan list.
  const parsedReport: unknown = run.reportJson
    ? JSON.parse(run.reportJson)
    : null;
  if (
    parsedReport !== null &&
    !Array.isArray(parsedReport) &&
    (parsedReport as { kind?: string }).kind === "linkedin"
  ) {
    return (
      <div>
        <header className="flex items-center justify-between border-b border-border px-5 py-2.5">
          <h1 className="text-sm font-semibold">
            LinkedIn import — {run.fileName ?? ""}
          </h1>
          <span className="text-[11px] text-muted-foreground">
            {new Date(run.startedAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}{" "}
            · {run.status}
          </span>
        </header>
        <LinkedInReportView
          runId={run.id}
          report={parsedReport as LinkedInReport}
        />
      </div>
    );
  }

  const stats = run.statsJson
    ? (JSON.parse(run.statsJson) as ImportStats)
    : null;
  const plans = (parsedReport as RowPlan[] | null) ?? [];

  const conflictRows = plans.flatMap((p) =>
    p.contactId !== null
      ? p.conflicts.map((c) => ({
          contactId: p.contactId as number,
          displayName: p.displayName,
          conflict: c,
        }))
      : []
  );
  const newRows = plans.filter((p) => p.status === "new");
  const updatedRows = plans.filter((p) => p.status === "updated");
  const errorRows = plans.filter((p) => p.status === "error");

  return (
    <div>
      <header className="flex items-center justify-between border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">
          Import report — {run.fileName ?? run.kind}
        </h1>
        <span className="text-[11px] text-muted-foreground">
          {new Date(run.startedAt).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}{" "}
          · {run.status}
        </span>
      </header>
      <div className="max-w-3xl space-y-6 px-5 py-4">
        {stats && <StatsRow stats={stats} />}

        <ConflictList runId={run.id} rows={conflictRows} />

        {errorRows.length > 0 && (
          <section className="space-y-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-destructive">
              Errors
            </h2>
            <ul className="space-y-1 text-[12.5px]">
              {errorRows.map((p, i) => (
                <li key={i} className="rounded-md border border-border/60 px-3 py-1.5">
                  {p.displayName}: {p.error}
                </li>
              ))}
            </ul>
          </section>
        )}

        {updatedRows.length > 0 && (
          <section className="space-y-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-blue-400">
              Updated ({updatedRows.length})
            </h2>
            <ul className="space-y-1 text-[12.5px]">
              {updatedRows.slice(0, 200).map((p, i) => (
                <li key={i} className="rounded-md border border-border/60 px-3 py-1.5">
                  <ContactLink plan={p} />
                  <span className="text-muted-foreground">
                    {" "}
                    {p.writes.length > 0 &&
                      `· ${p.writes.map((w) => `${w.field}${w.previous ? ` (${w.previous} → ${w.incoming})` : ""}`).join(", ")}`}
                    {p.newEmails.length > 0 && ` · +${p.newEmails.length} email`}
                    {p.newPhones.length > 0 && ` · +${p.newPhones.length} phone`}
                    {p.newSocials.length > 0 && ` · +${p.newSocials.length} link`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {newRows.length > 0 && (
          <section className="space-y-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-success">
              New ({newRows.length})
            </h2>
            <ul className="grid grid-cols-2 gap-1 text-[12.5px] sm:grid-cols-3">
              {newRows.slice(0, 300).map((p, i) => (
                <li key={i} className="truncate rounded-md border border-border/60 px-3 py-1.5">
                  <ContactLink plan={p} />
                </li>
              ))}
            </ul>
            {newRows.length > 300 && (
              <p className="text-[11px] text-muted-foreground">
                …and {newRows.length - 300} more
              </p>
            )}
          </section>
        )}

        {stats && stats.unchanged > 0 && (
          <p className="text-[12px] text-muted-foreground">
            {stats.unchanged} rows were identical to stored data — no writes.
          </p>
        )}
      </div>
    </div>
  );
}

function ContactLink({ plan }: { plan: RowPlan }) {
  if (plan.contactId === null) {
    return <span className="font-medium">{plan.displayName}</span>;
  }
  return (
    <Link
      href={`/contacts/${plan.contactId}`}
      className="font-medium hover:underline"
    >
      {plan.displayName}
    </Link>
  );
}
