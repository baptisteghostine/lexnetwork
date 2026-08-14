"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { syncRuns } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import type { RowPlan, ScalarField } from "@/lib/imports/types";
import { SCALAR_FIELDS } from "@/lib/imports/types";
import { applyScalarWrite, upsertProvenance } from "@/server/import-engine";

const acceptInput = z.object({
  runId: z.number().int(),
  contactId: z.number().int(),
  field: z.enum(SCALAR_FIELDS),
  value: z.string().min(1).max(1000),
});

/** One-click "accept incoming" on a reported conflict (SPEC §8). */
export async function acceptConflictAction(
  input: z.infer<typeof acceptInput>
): Promise<{ error?: string }> {
  await requireAuth();
  const parsed = acceptInput.safeParse(input);
  if (!parsed.success) return { error: "Invalid input." };
  const { runId, contactId, field, value } = parsed.data;

  const run = db.select().from(syncRuns).where(eq(syncRuns.id, runId)).get();
  if (!run?.reportJson) return { error: "Run not found." };

  const now = Date.now();
  const birthday =
    field === "birthday" ? (parseBirthday(value) ?? undefined) : undefined;
  if (field === "birthday" && !birthday) {
    return { error: "Unparseable birthday value." };
  }
  const source =
    run.kind === "vcard_import"
      ? "vcard"
      : run.kind === "linkedin_import"
        ? "linkedin"
        : "csv";

  db.transaction(() => {
    applyScalarWrite(contactId, field, value, birthday, now);
    upsertProvenance(contactId, field, source, runId, now);
    // Mark the conflict accepted in the stored report. Two report shapes
    // exist: CSV/vCard runs store a RowPlan[] array; LinkedIn runs store a
    // LinkedInReport object with a flat `conflicts` list.
    const parsedReport = JSON.parse(run.reportJson as string) as unknown;
    const markAccepted = (
      conflicts: { field: string; incoming: string; contactId?: number }[],
      matchContact: boolean
    ) => {
      for (const c of conflicts) {
        if (matchContact && c.contactId !== contactId) continue;
        if (c.field === field && c.incoming === value) {
          (c as { accepted?: boolean }).accepted = true;
        }
      }
    };
    if (Array.isArray(parsedReport)) {
      for (const p of parsedReport as RowPlan[]) {
        if (p.contactId !== contactId) continue;
        markAccepted(p.conflicts, false);
      }
    } else if (
      typeof parsedReport === "object" &&
      parsedReport !== null &&
      Array.isArray((parsedReport as { conflicts?: unknown }).conflicts)
    ) {
      markAccepted(
        (parsedReport as {
          conflicts: { field: string; incoming: string; contactId: number }[];
        }).conflicts,
        true
      );
    }
    db.update(syncRuns)
      .set({ reportJson: JSON.stringify(parsedReport) })
      .where(eq(syncRuns.id, runId))
      .run();
  });

  revalidatePath(`/imports/${runId}`);
  revalidatePath(`/contacts/${contactId}`);
  return {};
}

function parseBirthday(
  v: string
): { month: number; day: number; year: number | null } | null {
  const m = /^(\d{2})-(\d{2})(?:-(\d{4}))?$/.exec(v);
  if (!m) return null;
  return { month: Number(m[1]), day: Number(m[2]), year: m[3] ? Number(m[3]) : null };
}

// Type re-export for the report UI.
export type { RowPlan, ScalarField };
