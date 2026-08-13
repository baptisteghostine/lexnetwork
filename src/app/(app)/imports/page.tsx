import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";

import { ImportFlow } from "@/components/import-flow";
import { LinkedInImportCard } from "@/components/linkedin-import-card";
import { db } from "@/db/client";
import { syncRuns } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import type { ImportStats } from "@/lib/imports/types";
import { now as currentTime } from "@/lib/time";
import { reclaimStaleRuns } from "@/server/import-engine";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  csv_import: "CSV",
  vcard_import: "vCard",
  linkedin_import: "LinkedIn",
};

export default async function ImportsPage() {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  reclaimStaleRuns();
  const runs = db
    .select({
      id: syncRuns.id,
      kind: syncRuns.kind,
      fileName: syncRuns.fileName,
      status: syncRuns.status,
      statsJson: syncRuns.statsJson,
      startedAt: syncRuns.startedAt,
    })
    .from(syncRuns)
    .orderBy(desc(syncRuns.startedAt))
    .limit(50)
    .all();

  const lastLinkedIn = db
    .select({ startedAt: syncRuns.startedAt })
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.kind, "linkedin_import"),
        eq(syncRuns.status, "success")
      )
    )
    .orderBy(desc(syncRuns.startedAt))
    .get();

  return (
    <div>
      <header className="border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">Imports</h1>
      </header>
      <LinkedInImportCard
        daysAgo={
          lastLinkedIn
            ? Math.floor((currentTime() - lastLinkedIn.startedAt) / 86_400_000)
            : null
        }
      />
      <ImportFlow />
      {runs.length > 0 && (
        <section className="max-w-3xl space-y-2 px-5 pb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            History
          </h2>
          <ul className="space-y-1">
            {runs.map((r) => {
              const stats = r.statsJson
                ? (JSON.parse(r.statsJson) as ImportStats)
                : null;
              return (
                <li key={r.id}>
                  <Link
                    href={`/imports/${r.id}`}
                    className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2 text-[13px] transition-colors hover:bg-accent/50"
                  >
                    <span className="w-16 text-muted-foreground">
                      {KIND_LABEL[r.kind] ?? r.kind}
                    </span>
                    <span className="flex-1 truncate font-medium">
                      {r.fileName ?? "—"}
                    </span>
                    {stats && (
                      <span className="text-[11px] text-muted-foreground">
                        {stats.new} new · {stats.updated} updated ·{" "}
                        {stats.unchanged} unchanged
                        {stats.conflicts > 0 && (
                          <span className="text-warning">
                            {" "}
                            · {stats.conflicts} conflicts
                          </span>
                        )}
                      </span>
                    )}
                    <span
                      className={`text-[11px] ${r.status === "success" ? "text-success" : r.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {r.status}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {new Date(r.startedAt).toLocaleString(undefined, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
