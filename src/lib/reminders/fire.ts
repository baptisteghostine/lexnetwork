import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { interactions, reminders } from "@/db/schema";
import { nextOccurrence } from "@/lib/reminders/engine";

// Firing and occurrence materialization (SPEC §4). Exactly-once across
// crashes is anchored on the persisted fired_at column: the scheduler
// sweep only ever selects rows where fired_at IS NULL, so a restart
// re-fires nothing and a missed window fires once on the next tick.

export type FireableReminder = typeof reminders.$inferSelect;

/** Occurrences + one-offs due at `now` that have not fired. */
export function dueUnfired(now: number): FireableReminder[] {
  return db
    .select()
    .from(reminders)
    .where(
      and(
        isNull(reminders.rrule),
        isNull(reminders.completedAt),
        isNull(reminders.firedAt),
        sql`COALESCE(${reminders.snoozedUntil}, ${reminders.dueAt}) <= ${now}`
      )
    )
    .all();
}

/**
 * Ensure the series identified by its defining row has a live (unfired,
 * uncompleted) occurrence after `afterMs`; materializes one if missing.
 * Auto-completes the definer when the rule is exhausted (SPEC §4).
 */
export function materializeNext(definerId: number, afterMs: number): void {
  const definer = db
    .select()
    .from(reminders)
    .where(eq(reminders.id, definerId))
    .get();
  if (!definer?.rrule || definer.completedAt) return;

  const live = db
    .select({ id: reminders.id })
    .from(reminders)
    .where(
      and(
        eq(reminders.seriesId, definerId),
        isNull(reminders.completedAt),
        isNull(reminders.firedAt)
      )
    )
    .get();
  if (live) return;

  const now = Date.now();
  const nextAt = nextOccurrence(definer.rrule, definer.dueAt, afterMs);
  if (nextAt === null) {
    db.update(reminders)
      .set({ completedAt: now, updatedAt: now })
      .where(eq(reminders.id, definerId))
      .run();
    return;
  }
  db.insert(reminders)
    .values({
      contactId: definer.contactId,
      title: definer.title,
      body: definer.body,
      dueAt: nextAt,
      seriesId: definerId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/**
 * Fire one reminder: persist fired_at, write the (non-counting) timeline
 * interaction when contact-attached, and materialize the series' next
 * occurrence. Firing never touches next_touch_at (SPEC §3).
 *
 * The fired_at write is a compare-and-swap (WHERE fired_at IS NULL), so
 * two sweeps racing across processes fire a reminder exactly once — the
 * loser matches zero rows and skips the interaction write too.
 */
export function fireReminder(r: FireableReminder, now: number): boolean {
  let fired = false;
  db.transaction(() => {
    const claimed = db
      .update(reminders)
      .set({ firedAt: now, updatedAt: now })
      .where(and(eq(reminders.id, r.id), isNull(reminders.firedAt)))
      .run();
    if (claimed.changes === 0) return;
    fired = true;
    if (r.contactId !== null) {
      db.insert(interactions)
        .values({
          contactId: r.contactId,
          kind: "reminder_fired",
          occurredAt: now,
          title: r.title,
          source: "scheduler",
          countsForTouch: false,
          createdAt: now,
        })
        .run();
    }
    if (r.seriesId !== null) materializeNext(r.seriesId, r.dueAt);
  });
  return fired;
}

/** The scheduler-tick sweep. Returns how many actually fired. */
export function fireDueReminders(now: number): number {
  let fired = 0;
  for (const r of dueUnfired(now)) {
    if (fireReminder(r, now)) fired += 1;
  }
  return fired;
}
