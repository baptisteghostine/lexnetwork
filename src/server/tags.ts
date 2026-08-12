"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { tags } from "@/db/schema";
import { requireAuth } from "@/lib/auth";

const TAG_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#78716c",
] as const;

const tagInput = z.object({
  name: z.string().trim().min(1).max(50),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
});

export type TagFormState = { error?: string };

export async function createTagAction(
  _prev: TagFormState,
  formData: FormData
): Promise<TagFormState> {
  await requireAuth();
  const parsed = tagInput.safeParse({
    name: formData.get("name"),
    color: formData.get("color") ?? TAG_COLORS[0],
  });
  if (!parsed.success) return { error: "Tag needs a name (max 50 chars)." };
  try {
    db.insert(tags)
      .values({ ...parsed.data, createdAt: Date.now() })
      .run();
  } catch {
    return { error: `A tag named "${parsed.data.name}" already exists.` };
  }
  revalidatePath("/tags");
  revalidatePath("/contacts");
  return {};
}

export async function updateTagAction(
  tagId: number,
  _prev: TagFormState,
  formData: FormData
): Promise<TagFormState> {
  await requireAuth();
  const parsed = tagInput.safeParse({
    name: formData.get("name"),
    color: formData.get("color"),
  });
  if (!parsed.success) return { error: "Tag needs a name and a color." };
  try {
    db.update(tags).set(parsed.data).where(eq(tags.id, tagId)).run();
  } catch {
    return { error: `A tag named "${parsed.data.name}" already exists.` };
  }
  revalidatePath("/tags");
  revalidatePath("/contacts");
  return {};
}

export async function deleteTagAction(tagId: number): Promise<void> {
  await requireAuth();
  // contact_tags rows cascade.
  db.delete(tags).where(eq(tags.id, tagId)).run();
  revalidatePath("/tags");
  revalidatePath("/contacts");
}

export async function getTagColors(): Promise<readonly string[]> {
  return TAG_COLORS;
}
