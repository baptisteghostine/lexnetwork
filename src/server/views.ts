"use server";

import { asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db, rawDb } from "@/db/client";
import {
  contacts as contactsTable,
  customFields,
  groups,
  tags,
  views,
} from "@/db/schema";
import { compileFilter, haversineKm } from "@/lib/filters/compile";
import {
  parseFilterSet,
  type FilterSet,
  type SortSpec,
} from "@/lib/filters/types";
import { requireAuth } from "@/lib/auth";

// ---------- executor ----------

export type FilteredContact = typeof contactsTable.$inferSelect;

export type FilterRunResult = {
  contacts: FilteredContact[];
  warnings: string[];
};

/** Compile + run a filter set against the live DB (geocoder: not yet). */
export async function runFilter(
  filter: FilterSet,
  opts: { now: number; sort?: SortSpec }
): Promise<FilterRunResult> {
  await requireAuth();
  const catalog = {
    tagIds: new Set(db.select({ id: tags.id }).from(tags).all().map((t) => t.id)),
    groupIds: new Set(
      db.select({ id: groups.id }).from(groups).all().map((g) => g.id)
    ),
    customFieldIds: new Set(
      db.select({ id: customFields.id }).from(customFields).all().map((f) => f.id)
    ),
    geocoderConfigured: false,
  };
  const compiled = compileFilter(filter, { now: opts.now, sort: opts.sort, catalog });
  let rows = rawDb
    .prepare(compiled.sql)
    .all(...(compiled.params as unknown[])) as unknown as FilteredContact[];
  if (compiled.radius) {
    const { lat, lng, km } = compiled.radius;
    rows = rows.filter(
      (c) =>
        c.locationLat !== null &&
        c.locationLng !== null &&
        haversineKm(lat, lng, c.locationLat, c.locationLng) <= km
    );
  }
  // Raw rows come back snake_case; re-select through drizzle for camelCase.
  const ids = (rows as unknown as { id: number }[]).map((r) => r.id);
  if (ids.length === 0) return { contacts: [], warnings: compiled.warnings };
  const byId = new Map(
    db
      .select()
      .from(contactsTable)
      .all()
      .map((c) => [c.id, c] as const)
  );
  return {
    contacts: ids
      .map((id) => byId.get(id))
      .filter((c): c is FilteredContact => c !== undefined),
    warnings: compiled.warnings,
  };
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
