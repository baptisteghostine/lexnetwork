"use server";

import { and, asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { customFields, customFieldValues } from "@/db/schema";
import { requireAuth } from "@/lib/auth";

export type CustomFieldKind =
  | "text"
  | "number"
  | "date"
  | "single_select"
  | "multi_select";

export type CustomFieldDef = {
  id: number;
  name: string;
  kind: CustomFieldKind;
  options: string[];
};

export async function listCustomFields(): Promise<CustomFieldDef[]> {
  await requireAuth();
  return db
    .select()
    .from(customFields)
    .orderBy(asc(customFields.sortOrder), asc(customFields.name))
    .all()
    .map((f) => ({
      id: f.id,
      name: f.name,
      kind: f.kind as CustomFieldKind,
      options: f.options ? (JSON.parse(f.options) as string[]) : [],
    }));
}

const createInput = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["text", "number", "date", "single_select", "multi_select"]),
  options: z.array(z.string().trim().min(1).max(80)).max(50),
});

export async function createCustomFieldAction(input: {
  name: string;
  kind: CustomFieldKind;
  options: string[];
}): Promise<{ error?: string }> {
  await requireAuth();
  const parsed = createInput.safeParse(input);
  if (!parsed.success) return { error: "Invalid field definition." };
  const needsOptions =
    parsed.data.kind === "single_select" || parsed.data.kind === "multi_select";
  if (needsOptions && parsed.data.options.length === 0) {
    return { error: "Select fields need at least one option." };
  }
  try {
    db.insert(customFields)
      .values({
        name: parsed.data.name,
        kind: parsed.data.kind,
        options: needsOptions ? JSON.stringify(parsed.data.options) : null,
        createdAt: Date.now(),
      })
      .run();
  } catch {
    return { error: "A field with that name already exists." };
  }
  revalidatePath("/settings");
  return {};
}

export async function deleteCustomFieldAction(id: number): Promise<void> {
  await requireAuth();
  db.delete(customFields).where(eq(customFields.id, id)).run();
  revalidatePath("/settings");
  revalidatePath("/contacts");
}

export type CustomFieldValue = {
  fieldId: number;
  text: string | null;
  number: number | null;
  date: number | null;
  multi: string[];
};

export async function getCustomFieldValues(
  contactId: number
): Promise<CustomFieldValue[]> {
  await requireAuth();
  return db
    .select()
    .from(customFieldValues)
    .where(eq(customFieldValues.contactId, contactId))
    .all()
    .map((v) => ({
      fieldId: v.customFieldId,
      text: v.valueText,
      number: v.valueNumber,
      date: v.valueDate,
      multi: v.valueJson ? (JSON.parse(v.valueJson) as string[]) : [],
    }));
}

/** Upsert one field's value from its raw string form; empty clears. */
export async function setCustomFieldValueAction(
  contactId: number,
  fieldId: number,
  raw: string
): Promise<{ error?: string }> {
  await requireAuth();
  const field = db
    .select()
    .from(customFields)
    .where(eq(customFields.id, fieldId))
    .get();
  if (!field) return { error: "Field no longer exists." };
  const value = raw.trim();

  const clear = () =>
    db
      .delete(customFieldValues)
      .where(
        and(
          eq(customFieldValues.customFieldId, fieldId),
          eq(customFieldValues.contactId, contactId)
        )
      )
      .run();
  if (!value) {
    clear();
    revalidatePath(`/contacts/${contactId}`);
    return {};
  }

  let cols: {
    valueText?: string | null;
    valueNumber?: number | null;
    valueDate?: number | null;
    valueJson?: string | null;
  } = {};
  switch (field.kind as CustomFieldKind) {
    case "text":
      cols = { valueText: value };
      break;
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) return { error: "Not a number." };
      cols = { valueNumber: n };
      break;
    }
    case "date": {
      const t = Date.parse(value);
      if (Number.isNaN(t)) return { error: "Not a date." };
      cols = { valueDate: t };
      break;
    }
    case "single_select": {
      const options = field.options
        ? (JSON.parse(field.options) as string[])
        : [];
      if (!options.includes(value)) return { error: "Not an option." };
      cols = { valueText: value };
      break;
    }
    case "multi_select": {
      const options = field.options
        ? (JSON.parse(field.options) as string[])
        : [];
      const picked = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const bad = picked.find((p) => !options.includes(p));
      if (bad) return { error: `"${bad}" is not an option.` };
      cols = { valueJson: JSON.stringify(picked) };
      break;
    }
  }

  db.insert(customFieldValues)
    .values({
      customFieldId: fieldId,
      contactId,
      valueText: cols.valueText ?? null,
      valueNumber: cols.valueNumber ?? null,
      valueDate: cols.valueDate ?? null,
      valueJson: cols.valueJson ?? null,
    })
    .onConflictDoUpdate({
      target: [customFieldValues.customFieldId, customFieldValues.contactId],
      set: {
        valueText: cols.valueText ?? null,
        valueNumber: cols.valueNumber ?? null,
        valueDate: cols.valueDate ?? null,
        valueJson: cols.valueJson ?? null,
      },
    })
    .run();
  revalidatePath(`/contacts/${contactId}`);
  return {};
}
