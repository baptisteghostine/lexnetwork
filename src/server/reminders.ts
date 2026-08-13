"use server";

import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { contacts, reminders } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { describeRrule, sanitizeRrule } from "@/lib/reminders/engine";
import { materializeNext } from "@/lib/reminders/fire";

function revalidateReminderViews(contactId?: number | null) {
  revalidatePath("/reminders");
  revalidatePath("/today");
  if (contactId) revalidatePath(`/contacts/${contactId}`);
}

const createInput = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().max(5000).optional().default(""),
  dueAt: z.number().int().positive(),
  rrule: z.string().trim().max(200).optional().default(""),
  contactId: z.number().int().positive().nullable().optional().default(null),
});

export type ReminderFormState = { error?: string; created?: boolean };

export async function createReminderAction(
  _prev: ReminderFormState,
  formData: FormData
): Promise<ReminderFormState> {
  await requireAuth();
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("payload") ?? "{}"));
  } catch {
    return { error: "Malformed form payload." };
  }
  const parsed = createInput.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { error: `${first.path.join(".")}: ${first.message}` };
  }
  const p = parsed.data;

  let rrule: string | null = null;
  if (p.rrule) {
    rrule = sanitizeRrule(p.rrule);
    if (rrule === null) {
      return {
        error:
          "Recurrence must use FREQ daily/weekly/monthly/yearly with INTERVAL, BYDAY, BYMONTHDAY, UNTIL, or COUNT.",
      };
    }
  }

  const now = Date.now();
  db.transaction(() => {
    const row = db
      .insert(reminders)
      .values({
        contactId: p.contactId,
        title: p.title,
        body: p.body || null,
        dueAt: p.dueAt,
        rrule,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: reminders.id })
      .get();
    // A recurring definer never fires itself — materialize the first
    // occurrence (dueAt inclusive) as its own row.
    if (rrule !== null) materializeNext(row.id, p.dueAt - 1);
  });
  revalidateReminderViews(p.contactId);
  return { created: true };
}

export async function completeReminderAction(id: number): Promise<void> {
  await requireAuth();
  const r = db.select().from(reminders).where(eq(reminders.id, id)).get();
  if (!r || r.completedAt !== null) return;
  const now = Date.now();
  db.transaction(() => {
    db.update(reminders)
      .set({ completedAt: now, updatedAt: now })
      .where(eq(reminders.id, id))
      .run();
    // SPEC §4 AC: completing a recurring occurrence immediately shows the
    // next due date.
    if (r.seriesId !== null) materializeNext(r.seriesId, r.dueAt);
  });
  revalidateReminderViews(r.contactId);
}

export async function snoozeReminderAction(
  id: number,
  untilMs: number
): Promise<void> {
  await requireAuth();
  const r = db.select().from(reminders).where(eq(reminders.id, id)).get();
  if (!r || r.completedAt !== null) return;
  if (!Number.isInteger(untilMs) || untilMs <= Date.now()) return;
  db.update(reminders)
    .set({
      snoozedUntil: untilMs,
      // A snoozed reminder fires again at the new time.
      firedAt: null,
      updatedAt: Date.now(),
    })
    .where(eq(reminders.id, id))
    .run();
  revalidateReminderViews(r.contactId);
}

export async function deleteReminderAction(id: number): Promise<void> {
  await requireAuth();
  const r = db.select().from(reminders).where(eq(reminders.id, id)).get();
  if (!r) return;
  db.transaction(() => {
    // Deleting a recurring rule takes its unfired occurrences with it.
    if (r.rrule !== null) {
      db.delete(reminders)
        .where(
          and(
            eq(reminders.seriesId, r.id),
            isNull(reminders.firedAt),
            isNull(reminders.completedAt)
          )
        )
        .run();
    }
    db.delete(reminders).where(eq(reminders.id, id)).run();
  });
  revalidateReminderViews(r.contactId);
}

// ---------- queries (page data) ----------

export type ReminderListRow = {
  id: number;
  title: string;
  body: string | null;
  dueAt: number;
  effectiveDueAt: number;
  fired: boolean;
  isOccurrence: boolean;
  rrule: string | null;
  rruleText: string | null;
  contactId: number | null;
  contactName: string | null;
};

export async function listReminders(now: number): Promise<{
  due: ReminderListRow[];
  upcoming: ReminderListRow[];
  recurring: ReminderListRow[];
}> {
  await requireAuth();
  const rows = db
    .select({
      r: reminders,
      contactName: contacts.displayName,
    })
    .from(reminders)
    .leftJoin(contacts, eq(contacts.id, reminders.contactId))
    .where(isNull(reminders.completedAt))
    .orderBy(asc(reminders.dueAt))
    .all();

  const toRow = (x: (typeof rows)[number]): ReminderListRow => ({
    id: x.r.id,
    title: x.r.title,
    body: x.r.body,
    dueAt: x.r.dueAt,
    effectiveDueAt: x.r.snoozedUntil ?? x.r.dueAt,
    fired: x.r.firedAt !== null,
    isOccurrence: x.r.seriesId !== null,
    rrule: x.r.rrule,
    rruleText: x.r.rrule ? describeRrule(x.r.rrule) : null,
    contactId: x.r.contactId,
    contactName: x.contactName ?? null,
  });

  const due: ReminderListRow[] = [];
  const upcoming: ReminderListRow[] = [];
  const recurring: ReminderListRow[] = [];
  for (const x of rows) {
    const row = toRow(x);
    if (x.r.rrule !== null) recurring.push(row);
    else if (row.effectiveDueAt <= now) due.push(row);
    else upcoming.push(row);
  }
  // For each recurring rule, surface its next live occurrence date.
  for (const rec of recurring) {
    const nextOcc = db
      .select({ dueAt: reminders.dueAt, snoozedUntil: reminders.snoozedUntil })
      .from(reminders)
      .where(
        and(
          eq(reminders.seriesId, rec.id),
          isNull(reminders.completedAt),
          isNull(reminders.firedAt),
          gt(sql`COALESCE(${reminders.snoozedUntil}, ${reminders.dueAt})`, 0)
        )
      )
      .orderBy(asc(reminders.dueAt))
      .get();
    if (nextOcc) {
      rec.effectiveDueAt = nextOcc.snoozedUntil ?? nextOcc.dueAt;
    }
  }
  return { due, upcoming, recurring };
}
