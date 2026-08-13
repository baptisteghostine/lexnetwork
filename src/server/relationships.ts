"use server";

import { eq, inArray, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { contactRelationships, contacts } from "@/db/schema";
import { requireAuth } from "@/lib/auth";

// Related-contacts edges (SPEC §10, SCHEMA.md contact_relationships).
// Ordering rule: undirected edges are stored canonicalized a<b; directed
// edges store their semantic order — (a,b) reads "A <label> B", e.g.
// "A introduced_by B".

export type RelationshipEdge = {
  id: number;
  otherId: number;
  otherName: string;
  label: string;
  /** 'out' = this contact is A of a directed edge, 'in' = B, null = undirected. */
  direction: "out" | "in" | null;
  note: string | null;
};

export async function readRelationships(
  contactId: number
): Promise<RelationshipEdge[]> {
  await requireAuth();
  const rows = db
    .select({
      id: contactRelationships.id,
      aId: contactRelationships.contactAId,
      bId: contactRelationships.contactBId,
      label: contactRelationships.label,
      directed: contactRelationships.directed,
      note: contactRelationships.note,
    })
    .from(contactRelationships)
    .where(
      or(
        eq(contactRelationships.contactAId, contactId),
        eq(contactRelationships.contactBId, contactId)
      )
    )
    .all();
  if (rows.length === 0) return [];
  const otherIds = [...new Set(rows.map((r) => (r.aId === contactId ? r.bId : r.aId)))];
  const names = new Map(
    db
      .select({ id: contacts.id, name: contacts.displayName })
      .from(contacts)
      .where(inArray(contacts.id, otherIds))
      .all()
      .map((c) => [c.id, c.name])
  );
  return rows.map((r) => {
    const otherId = r.aId === contactId ? r.bId : r.aId;
    return {
      id: r.id,
      otherId,
      otherName: names.get(otherId) ?? `#${otherId}`,
      label: r.label,
      direction: r.directed ? (r.aId === contactId ? "out" : "in") : null,
      note: r.note,
    };
  });
}

const addInput = z.object({
  contactId: z.number().int().positive(),
  otherId: z.number().int().positive(),
  label: z.string().trim().min(1).max(40),
  directed: z.boolean(),
  note: z.string().trim().max(500).optional(),
});

export async function addRelationshipAction(input: {
  contactId: number;
  otherId: number;
  label: string;
  directed: boolean;
  note?: string;
}): Promise<{ error?: string }> {
  await requireAuth();
  const parsed = addInput.safeParse(input);
  if (!parsed.success) return { error: "Invalid relationship." };
  const { contactId, otherId, label, directed, note } = parsed.data;
  if (contactId === otherId) {
    return { error: "A contact can't relate to themselves." };
  }
  // Directed rows keep semantic order (this contact is A: "A <label> B");
  // undirected rows canonicalize.
  const [a, b] =
    directed || contactId < otherId ? [contactId, otherId] : [otherId, contactId];
  try {
    db.insert(contactRelationships)
      .values({
        contactAId: a,
        contactBId: b,
        label: label.toLowerCase(),
        directed,
        note: note || null,
        createdAt: Date.now(),
      })
      .run();
  } catch {
    return { error: "These two are already linked with that label." };
  }
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath(`/contacts/${otherId}`);
  return {};
}

export async function removeRelationshipAction(input: {
  id: number;
}): Promise<void> {
  await requireAuth();
  const row = db
    .select({
      aId: contactRelationships.contactAId,
      bId: contactRelationships.contactBId,
    })
    .from(contactRelationships)
    .where(eq(contactRelationships.id, input.id))
    .get();
  db.delete(contactRelationships)
    .where(eq(contactRelationships.id, input.id))
    .run();
  if (row) {
    revalidatePath(`/contacts/${row.aId}`);
    revalidatePath(`/contacts/${row.bId}`);
  }
}
