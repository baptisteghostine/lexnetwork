import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db } from "@/db/client";
import { contactChanges, contacts } from "@/db/schema";
import {
  buildNetworkUpdates,
  collapseUpdates,
  type NetworkUpdate,
} from "@/lib/digest/network-updates";
import { sendEmail } from "@/lib/digest/send";
import { getSetting } from "@/lib/settings";
import { aiEnabled } from "@/server/ai-client";
import { triageFor } from "@/server/ai-triage";

// With AI on, a change waits for its triage verdict (up to an hour) so
// the email carries the reason, and low-signal changes — renames and
// headline tweaks — are stamped as told without ever being sent. The
// wait is for the batch, not per row: while any pending change is still
// being triaged, nothing goes out, so one import's news lands in one
// email instead of trickling out a triage batch at a time.
const TRIAGE_WAIT_MS = 60 * 60 * 1000;

// Edge-triggered email for job changes (SPEC §5). The scheduler sweeps
// this on a short interval; almost every sweep finds nothing and returns
// "none" without touching SMTP. It only has something to say after an
// import — LinkedIn ZIP, extension sync, CSV — detected a move.
//
// Exactly-once is a ledger, not a timer: a change is only ever sent while
// contact_changes.notified_at is NULL, and the stamp is written after the
// send returns. A crash between send and stamp re-sends one email; a
// crash the other way round would silently swallow the news, which is the
// worse failure for a product whose whole job is not missing these.

export function networkUpdatesEnabled(): boolean {
  return getSetting<boolean>("network_updates.email") ?? true;
}

/** Open, never-emailed changes, collapsed by `collapseUpdates`. `held` is
 * how many are still waiting on triage — when it is above zero nothing is
 * returned as ready. */
export function pendingNetworkUpdates(now = Date.now()): {
  ids: number[];
  updates: NetworkUpdate[];
  held: number;
} {
  const rows = db
    .select({
      id: contactChanges.id,
      contactId: contactChanges.contactId,
      field: contactChanges.field,
      oldValue: contactChanges.oldValue,
      newValue: contactChanges.newValue,
      detectedAt: contactChanges.detectedAt,
      displayName: contacts.displayName,
    })
    .from(contactChanges)
    .innerJoin(contacts, eq(contacts.id, contactChanges.contactId))
    .where(
      and(
        isNull(contactChanges.notifiedAt),
        isNull(contactChanges.dismissedAt),
        isNull(contactChanges.actedAt),
        isNull(contacts.archivedAt)
      )
    )
    .orderBy(asc(contactChanges.detectedAt))
    .all();

  const verdicts = triageFor(rows.map((r) => r.id));
  const waiting = aiEnabled()
    ? rows.filter((r) => !verdicts.has(r.id) && now - r.detectedAt < TRIAGE_WAIT_MS).length
    : 0;
  if (waiting > 0) return { ids: [], updates: [], held: waiting };
  const lowSignalIds: number[] = [];
  const ready = rows.filter((r) => {
    if (verdicts.get(r.id)?.lowSignal) {
      lowSignalIds.push(r.id);
      return false;
    }
    return true;
  });
  const collapsed = collapseUpdates(
    ready.map((r) => ({
      ...r,
      field: r.field as "company" | "title",
      reason: verdicts.get(r.id)?.triage.reason || null,
    }))
  );
  return { ids: [...collapsed.ids, ...lowSignalIds], updates: collapsed.updates, held: 0 };
}

export function markNotified(ids: number[], now: number): void {
  if (ids.length === 0) return;
  db.update(contactChanges)
    .set({ notifiedAt: now })
    .where(inArray(contactChanges.id, ids))
    .run();
}

export type NetworkUpdatesResult = "sent" | "none" | "held" | "disabled";

export async function runNetworkUpdates(
  now: number
): Promise<NetworkUpdatesResult> {
  if (!networkUpdatesEnabled()) return "disabled";
  const { ids, updates, held } = pendingNetworkUpdates(now);
  if (held > 0) return "held";
  if (updates.length === 0) {
    // Nothing to say — but stamp any orphans (all superseded, or the
    // contact got archived) so they can't accumulate forever.
    markNotified(ids, now);
    return "none";
  }
  const email = buildNetworkUpdates({
    updates,
    appUrl: getSetting<string>("app_url") ?? "http://localhost:3000",
    now,
  });
  await sendEmail(email);
  markNotified(ids, now);
  return "sent";
}
