"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  setCustomFieldValueAction,
  type CustomFieldDef,
  type CustomFieldValue,
} from "@/server/custom-fields";

// Inline editors on the contact detail panel — save on blur/Enter.
export function CustomFieldValues({
  contactId,
  fields,
  values,
}: {
  contactId: number;
  fields: CustomFieldDef[];
  values: CustomFieldValue[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<number, string>>({});

  if (fields.length === 0) return null;
  const byField = new Map(values.map((v) => [v.fieldId, v]));

  const initial = (f: CustomFieldDef): string => {
    const v = byField.get(f.id);
    if (!v) return "";
    switch (f.kind) {
      case "number":
        return v.number !== null ? String(v.number) : "";
      case "date":
        return v.date !== null
          ? new Date(v.date).toISOString().slice(0, 10)
          : "";
      case "multi_select":
        return v.multi.join(", ");
      default:
        return v.text ?? "";
    }
  };

  const save = (f: CustomFieldDef, raw: string) =>
    startTransition(async () => {
      const res = await setCustomFieldValueAction(contactId, f.id, raw);
      setErrors((prev) => ({ ...prev, [f.id]: res.error ?? "" }));
      if (!res.error) router.refresh();
    });

  return (
    <dl className="space-y-2.5 text-[13px]">
      {fields.map((f) => (
        <div key={f.id} className="grid grid-cols-[5.5rem_1fr] gap-x-3">
          <dt className="truncate pt-1 text-muted-foreground" title={f.name}>
            {f.name}
          </dt>
          <dd className="min-w-0">
            {f.kind === "single_select" ? (
              <select
                defaultValue={initial(f)}
                onChange={(e) => save(f, e.target.value)}
                className="h-7 w-full rounded-md border border-input bg-transparent px-1.5 text-[13px]"
              >
                <option value="">—</option>
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={
                  f.kind === "number"
                    ? "number"
                    : f.kind === "date"
                      ? "date"
                      : "text"
                }
                defaultValue={initial(f)}
                placeholder={
                  f.kind === "multi_select"
                    ? f.options.slice(0, 3).join(", ")
                    : "—"
                }
                onBlur={(e) => {
                  if (e.target.value !== initial(f)) save(f, e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="h-7 w-full rounded-md border border-transparent bg-transparent px-1.5 text-[13px] hover:border-input focus:border-input focus:outline-none"
              />
            )}
            {errors[f.id] ? (
              <p className="mt-0.5 text-[11px] text-destructive">
                {errors[f.id]}
              </p>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
