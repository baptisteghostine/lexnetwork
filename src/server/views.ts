"use server";

import { asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { views } from "@/db/schema";
import {
  parseFilterSet,
  type FilterSet,
  type SortSpec,
} from "@/lib/filters/types";
import { requireAuth } from "@/lib/auth";
import { executeFilter, type FilterRunResult } from "@/server/queries";

// ---------- executor ----------

/**
 * Compile + run a filter set against the live DB. The work is
 * `executeFilter` (src/server/queries.ts) — this is the session-gated
 * door to it for pages and other actions (SPEC §14: an export of a
 * "use server" file is an endpoint, so the logic itself lives elsewhere).
 */
export async function runFilter(
  filter: FilterSet,
  opts: { now: number; sort?: SortSpec; limit?: number; offset?: number }
): Promise<FilterRunResult> {
  await requireAuth();
  return executeFilter(filter, opts);
}

// ---------- views CRUD ----------

export type ViewRow = {
  id: number;
  name: string;
  filterJson: string;
  sortJson: string | null;
  pinned: boolean;
  sortOrder: number | null;
};

export async function listViews(): Promise<ViewRow[]> {
  await requireAuth();
  return db
    .select()
    .from(views)
    .orderBy(asc(views.sortOrder), asc(views.name))
    .all()
    .map((v) => ({
      id: v.id,
      name: v.name,
      filterJson: v.filterJson,
      sortJson: v.sortJson,
      pinned: v.pinned,
      sortOrder: v.sortOrder,
    }));
}

const createInput = z.object({
  name: z.string().trim().min(1).max(80),
  filterJson: z.string().max(20_000),
  sortJson: z.string().max(1000).nullable(),
});

export async function createViewAction(input: {
  name: string;
  filterJson: string;
  sortJson: string | null;
}): Promise<{ error?: string; id?: number }> {
  await requireAuth();
  const parsed = createInput.safeParse(input);
  if (!parsed.success) return { error: "Invalid view." };
  if (parseFilterSet(parsed.data.filterJson) === null) {
    return { error: "Invalid filter definition." };
  }
  const now = Date.now();
  const maxOrder =
    db
      .select({ o: views.sortOrder })
      .from(views)
      .all()
      .reduce((m, r) => Math.max(m, r.o ?? 0), 0) + 1;
  const row = db
    .insert(views)
    .values({
      name: parsed.data.name,
      filterJson: parsed.data.filterJson,
      sortJson: parsed.data.sortJson,
      pinned: true,
      sortOrder: maxOrder,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: views.id })
    .get();
  revalidatePath("/contacts");
  return { id: row.id };
}

export async function deleteViewAction(id: number): Promise<void> {
  await requireAuth();
  db.delete(views).where(eq(views.id, id)).run();
  revalidatePath("/contacts");
}

export async function setViewPinnedAction(
  id: number,
  pinned: boolean
): Promise<void> {
  await requireAuth();
  db.update(views)
    .set({ pinned, updatedAt: Date.now() })
    .where(eq(views.id, id))
    .run();
  revalidatePath("/contacts");
}

/** Persist a full pinned-order (drag-reorder in the sidebar). */
export async function reorderViewsAction(orderedIds: number[]): Promise<void> {
  await requireAuth();
  const now = Date.now();
  db.transaction(() => {
    orderedIds.forEach((id, i) => {
      if (!Number.isInteger(id)) return;
      db.update(views)
        .set({ sortOrder: i + 1, updatedAt: now })
        .where(eq(views.id, id))
        .run();
    });
  });
  revalidatePath("/contacts");
}
