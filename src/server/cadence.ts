"use server";

import { and, eq, isNull, isNotNull, lte } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import {
  planSnoozeAll,
  snoozeUntil,
  type SnoozePreset,
} from "@/lib/cadence/engine";
import { recomputeContact } from "@/lib/cadence/recompute";
import { ownerTimezone } from "@/server/today-data";
import { getSetting } from "@/lib/settings";

function revalidateCadenceViews(contactId?: number) {
  revalidatePath("/today");
  revalidatePath("/contacts");
  if (contactId) revalidatePath(`/contacts/${contactId}`);
}

const cadenceDaysSchema = z.number().int().min(1).max(3650).nullable();

export async function setCadenceAction(
  contactId: number,
  days: number | null
): Promise<{ error?: string }> {
  await requireAuth();
  const parsed = cadenceDaysSchema.safeParse(days);
  if (!parsed.success) return { error: "Cadence must be 1–3650 days." };
  const now = Date.now();
  db.update(contacts)
    .set({
      cadenceDays: parsed.data,
      // Re-assigning restarts the no-interaction baseline; clearing wipes it.
      cadenceAssignedAt: parsed.data === null ? null : now,
      snoozedUntil: null,
      updatedAt: now,
    })
    .where(eq(contacts.id, contactId))
    .run();
  recomputeContact(contactId);
  revalidateCadenceViews(contactId);
  return {};
}

export async function bulkSetCadenceAction(
  contactIds: number[],
  days: number | null
): Promise<{ error?: string }> {
  await requireAuth();
  const parsed = z.array(z.number().int()).min(1).max(1000).safeParse(contactIds);
  const parsedDays = cadenceDaysSchema.safeParse(days);
  if (!parsed.success || !parsedDays.success) return { error: "Invalid input." };
  const now = Date.now();
  db.transaction(() => {
    for (const id of parsed.data) {
      db.update(contacts)
        .set({
          cadenceDays: parsedDays.data,
          cadenceAssignedAt: parsedDays.data === null ? null : now,
          snoozedUntil: null,
          updatedAt: now,
        })
        .where(eq(contacts.id, id))
        .run();
      recomputeContact(id);
    }
  });
  revalidateCadenceViews();
  return {};
}

export async function snoozeContactAction(
  contactId: number,
  preset: SnoozePreset | { untilMs: number }
): Promise<{ error?: string }> {
  await requireAuth();
  const now = Date.now();
  const until =
    typeof preset === "string" ? snoozeUntil(preset, now) : preset.untilMs;
  if (!Number.isFinite(until) || until <= now) {
    return { error: "Snooze must be in the future." };
  }
  db.update(contacts)
    .set({ snoozedUntil: until, updatedAt: now })
    .where(eq(contacts.id, contactId))
    .run();
  recomputeContact(contactId);
  revalidateCadenceViews(contactId);
  return {};
}

/** Redistributes every currently-due contact across coming weekdays. */
export async function snoozeAllAction(): Promise<{ moved: number }> {
  await requireAuth();
  const now = Date.now();
  const due = db
    .select({
      id: contacts.id,
      starred: contacts.starred,
      nextTouchAt: contacts.nextTouchAt,
    })
    .from(contacts)
    .where(
      and(
        isNull(contacts.archivedAt),
        isNotNull(contacts.cadenceDays),
        isNotNull(contacts.nextTouchAt),
        lte(contacts.nextTouchAt, now)
      )
    )
    .all();

  const plan = planSnoozeAll(
    due.map((d) => ({ ...d, nextTouchAt: d.nextTouchAt as number })),
    {
      now,
      horizonDays: getSetting<number>("snooze_all.horizon_days") ?? 21,
      perDayFloor: getSetting<number>("snooze_all.per_day_floor") ?? 3,
      digestHour: getSetting<number>("digest.hour") ?? 8,
      timezone: ownerTimezone(),
    }
  );

  db.transaction(() => {
    for (const p of plan) {
      db.update(contacts)
        .set({ snoozedUntil: p.snoozedUntil, updatedAt: now })
        .where(eq(contacts.id, p.contactId))
        .run();
      recomputeContact(p.contactId);
    }
  });
  revalidateCadenceViews();
  return { moved: plan.length };
}
