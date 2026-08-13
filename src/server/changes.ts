"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import {
  contactChanges,
  contactSocials,
  interactions,
  syncRuns,
} from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { recomputeContact } from "@/lib/cadence/recompute";
import {
  insertLinkedInMessages,
  type LinkedInReport,
} from "@/server/linkedin-import";

function revalidateChangeViews(contactId: number) {
  revalidatePath("/today");
  revalidatePath(`/contacts/${contactId}`);
}

/** SPEC §5 AC: dismissing removes the card from Today permanently; the
 * change row stays on the contact's timeline. */
export async function dismissChangeAction(id: number): Promise<void> {
  await requireAuth();
  const row = db
    .select()
    .from(contactChanges)
    .where(eq(contactChanges.id, id))
    .get();
  if (!row || row.dismissedAt !== null) return;
  db.update(contactChanges)
    .set({ dismissedAt: Date.now() })
    .where(eq(contactChanges.id, id))
    .run();
  revalidateChangeViews(row.contactId);
}

/** "Log interaction" on a change card: records the outreach (counts for
 * touch) and marks the card acted. */
export async function actOnChangeAction(id: number): Promise<void> {
  await requireAuth();
  const row = db
    .select()
    .from(contactChanges)
    .where(eq(contactChanges.id, id))
    .get();
  if (!row || row.actedAt !== null) return;
  const now = Date.now();
  db.transaction(() => {
    db.insert(interactions)
      .values({
        contactId: row.contactId,
        kind: "manual",
        occurredAt: now,
        title: `Reached out — ${row.oldValue ?? "?"} → ${row.newValue ?? "?"}`,
        source: "user",
        countsForTouch: true,
        createdAt: now,
      })
      .run();
    db.update(contactChanges)
      .set({ actedAt: now })
      .where(eq(contactChanges.id, id))
      .run();
  });
  recomputeContact(row.contactId);
  revalidateChangeViews(row.contactId);
}

/** Unmatched-conversation picker: link a conversation from a LinkedIn run
 * to a contact — writes its messages idempotently and remembers nothing
 * else (the next import matches by the social URL we add). */
export async function linkConversationAction(
  runId: number,
  conversationId: string,
  contactId: number
): Promise<{ error?: string }> {
  await requireAuth();
  const run = db
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.id, runId))
    .get();
  if (!run?.reportJson) return { error: "Run not found." };
  let report: LinkedInReport;
  try {
    report = JSON.parse(run.reportJson) as LinkedInReport;
  } catch {
    return { error: "Report unreadable." };
  }
  const convo = report.unmatched.find(
    (u) => u.conversationId === conversationId
  );
  if (!convo) return { error: "Conversation not in this run." };

  const inserted = insertLinkedInMessages(
    contactId,
    conversationId,
    convo.messages,
    runId
  );
  if (convo.counterpartProfileUrl) {
    db.insert(contactSocials)
      .values({
        contactId,
        platform: "linkedin",
        url: `https://${convo.counterpartProfileUrl}`,
        source: "linkedin",
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  }
  recomputeContact(contactId);

  report.unmatched = report.unmatched.filter(
    (u) => u.conversationId !== conversationId
  );
  report.messagesLinked += inserted;
  db.update(syncRuns)
    .set({ reportJson: JSON.stringify(report) })
    .where(eq(syncRuns.id, runId))
    .run();
  revalidatePath(`/imports/${runId}`);
  revalidatePath(`/contacts/${contactId}`);
  return {};
}
