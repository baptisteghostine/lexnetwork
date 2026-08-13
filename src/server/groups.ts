"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { groups } from "@/db/schema";
import { requireAuth } from "@/lib/auth";

const groupInput = z.object({
  name: z.string().trim().min(1).max(60),
  emoji: z.string().trim().max(8).optional().default(""),
  parentId: z.number().int().nullable().default(null),
});

export type GroupFormState = { error?: string };

const MAX_DEPTH = 3;

function depthOf(groupId: number | null): number {
  let depth = 0;
  let current = groupId;
  while (current !== null && depth <= MAX_DEPTH) {
    const row = db
      .select({ parentId: groups.parentId })
      .from(groups)
      .where(eq(groups.id, current))
      .get();
    if (!row) break;
    depth += 1;
    current = row.parentId;
  }
  return depth;
}

export async function createGroupAction(
  _prev: GroupFormState,
  formData: FormData
): Promise<GroupFormState> {
  await requireAuth();
  const parentRaw = formData.get("parentId");
  const parsed = groupInput.safeParse({
    name: formData.get("name"),
    emoji: formData.get("emoji") ?? "",
    parentId: parentRaw ? Number(parentRaw) : null,
  });
  if (!parsed.success) return { error: "Group needs a name (max 60 chars)." };
  if (depthOf(parsed.data.parentId) >= MAX_DEPTH) {
    return { error: `Groups can nest at most ${MAX_DEPTH} levels deep.` };
  }
  try {
    db.insert(groups)
      .values({
        name: parsed.data.name,
        emoji: parsed.data.emoji || null,
        parentId: parsed.data.parentId,
        createdAt: Date.now(),
      })
      .run();
  } catch {
    return { error: `A group named "${parsed.data.name}" already exists here.` };
  }
  revalidatePath("/groups");
  return {};
}

export async function updateGroupAction(
  groupId: number,
  _prev: GroupFormState,
  formData: FormData
): Promise<GroupFormState> {
  await requireAuth();
  const parsed = groupInput.safeParse({
    name: formData.get("name"),
    emoji: formData.get("emoji") ?? "",
    parentId: null, // reparenting isn't supported from the edit form
  });
  if (!parsed.success) return { error: "Group needs a name." };
  try {
    db.update(groups)
      .set({ name: parsed.data.name, emoji: parsed.data.emoji || null })
      .where(eq(groups.id, groupId))
      .run();
  } catch {
    return { error: `A group named "${parsed.data.name}" already exists here.` };
  }
  revalidatePath("/groups");
  return {};
}

export async function deleteGroupAction(groupId: number): Promise<void> {
  await requireAuth();
  // Children are re-rooted (parent_id SET NULL); memberships cascade.
  db.delete(groups).where(eq(groups.id, groupId)).run();
  revalidatePath("/groups");
}
