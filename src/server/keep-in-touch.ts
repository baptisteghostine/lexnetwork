"use server";

import { isNull, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import {
  bucketFor,
  bucketId,
  CADENCE_PRESETS,
} from "@/lib/cadence/engine";
import { recomputeContact } from "@/lib/cadence/recompute";

// The Keep-in-touch board (SPEC §3a): every contact sits in exactly one
// frequency column, and the whole point is emptying the Uncategorized one.
// Bucketing happens here rather than in SQL because the rules live in the
// pure engine, where they're unit-tested.

/**
 * Cards rendered per column. The board's job at 3k+ contacts is triage,
 * not exhaustive display: headers carry the true totals, and the columns
 * refill as you clear them. Without a cap, one Uncategorized column of
 * several thousand cards would dominate every render. Not exported — a
 * "use server" module may only export async functions.
 */
const PER_COLUMN_LIMIT = 100;

export type BoardCard = {
  id: number;
  displayName: string;
  company: string | null;
  title: string | null;
  starred: boolean;
  hasPhoto: boolean;
  lastInteractionAt: number | null;
};

export type BoardColumn = {
  id: string;
  label: string;
  /** Assign target: a day count, or the two null-cadence states. */
  target: number | "never" | "unset";
  total: number;
  cards: BoardCard[];
};

export type KeepInTouchBoard = {
  columns: BoardColumn[];
  totalContacts: number;
  untriaged: number;
};

export async function readKeepInTouchBoard(): Promise<KeepInTouchBoard> {
  await requireAuth();
  const rows = db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      company: contacts.company,
      title: contacts.title,
      starred: contacts.starred,
      photoPath: contacts.photoPath,
      lastInteractionAt: contacts.lastInteractionAt,
      cadenceDays: contacts.cadenceDays,
      cadenceReviewedAt: contacts.cadenceReviewedAt,
    })
    .from(contacts)
    .where(isNull(contacts.archivedAt))
    .all();

  const byBucket = new Map<string, BoardCard[]>();
  for (const row of rows) {
    const key = bucketId(bucketFor(row));
    const card: BoardCard = {
      id: row.id,
      displayName: row.displayName,
      company: row.company,
      title: row.title,
      starred: row.starred,
      hasPhoto: row.photoPath !== null,
      lastInteractionAt: row.lastInteractionAt,
    };
    const list = byBucket.get(key);
    if (list) list.push(card);
    else byBucket.set(key, [card]);
  }

  // Starred first, then people you've actually spoken to most recently —
  // so triaging from the top of Uncategorized hits the contacts that
  // matter before the long tail of never-contacted imports.
  const order = (cards: BoardCard[]): BoardCard[] =>
    cards.sort((a, b) => {
      if (a.starred !== b.starred) return a.starred ? -1 : 1;
      const ai = a.lastInteractionAt ?? -1;
      const bi = b.lastInteractionAt ?? -1;
      if (ai !== bi) return bi - ai;
      return a.displayName.localeCompare(b.displayName);
    });

  const column = (
    id: string,
    label: string,
    target: number | "never" | "unset"
  ): BoardColumn => {
    const cards = order(byBucket.get(id) ?? []);
    return { id, label, target, total: cards.length, cards: cards.slice(0, PER_COLUMN_LIMIT) };
  };

  const columns: BoardColumn[] = CADENCE_PRESETS.map((p) =>
    column(String(p.days), p.label, p.days)
  );
  // Only surfaced when populated: a cadence typed by hand that matches no
  // preset still has to live somewhere visible.
  const custom = column("custom", "Custom", "unset");
  if (custom.total > 0) columns.push(custom);
  columns.push(column("unset", "Uncategorized", "unset"));
  columns.push(column("never", "Don't keep in touch", "never"));

  return {
    columns,
    totalContacts: rows.length,
    untriaged: byBucket.get("unset")?.length ?? 0,
  };
}

const targetSchema = z.union([
  z.number().int().min(1).max(3650),
  z.literal("never"),
  z.literal("unset"),
]);

/**
 * Move contacts into a column. The three destinations write different
 * shapes:
 *  - a day count  → cadence set, decision recorded
 *  - 'never'      → no cadence, decision recorded (leaves Uncategorized)
 *  - 'unset'      → back to never-triaged (the undo target)
 */
export async function setKeepInTouchAction(
  contactIds: number[],
  target: number | "never" | "unset"
): Promise<{ error?: string }> {
  await requireAuth();
  const ids = z.array(z.number().int()).min(1).max(1000).safeParse(contactIds);
  const parsedTarget = targetSchema.safeParse(target);
  if (!ids.success || !parsedTarget.success) return { error: "Invalid input." };

  const now = Date.now();
  const t = parsedTarget.data;
  const patch =
    typeof t === "number"
      ? {
          cadenceDays: t,
          cadenceAssignedAt: now,
          cadenceReviewedAt: now,
          snoozedUntil: null,
          updatedAt: now,
        }
      : t === "never"
        ? {
            cadenceDays: null,
            cadenceAssignedAt: null,
            cadenceReviewedAt: now,
            snoozedUntil: null,
            updatedAt: now,
          }
        : {
            cadenceDays: null,
            cadenceAssignedAt: null,
            cadenceReviewedAt: null,
            snoozedUntil: null,
            updatedAt: now,
          };

  db.transaction(() => {
    db.update(contacts).set(patch).where(inArray(contacts.id, ids.data)).run();
    for (const id of ids.data) recomputeContact(id);
  });

  revalidatePath("/keep-in-touch");
  revalidatePath("/today");
  revalidatePath("/contacts");
  return {};
}
