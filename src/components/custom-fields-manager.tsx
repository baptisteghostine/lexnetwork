"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createCustomFieldAction,
  deleteCustomFieldAction,
  type CustomFieldDef,
  type CustomFieldKind,
} from "@/server/custom-fields";

const KINDS: { kind: CustomFieldKind; label: string }[] = [
  { kind: "text", label: "Text" },
  { kind: "number", label: "Number" },
  { kind: "date", label: "Date" },
  { kind: "single_select", label: "Select (one)" },
  { kind: "multi_select", label: "Select (many)" },
];

export function CustomFieldsManager({ fields }: { fields: CustomFieldDef[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CustomFieldKind>("text");
  const [options, setOptions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const needsOptions = kind === "single_select" || kind === "multi_select";

  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const res = await createCustomFieldAction({
              name,
              kind,
              options: needsOptions
                ? options.split(",").map((s) => s.trim()).filter(Boolean)
                : [],
            });
            if (res.error) {
              setError(res.error);
              return;
            }
            setError(null);
            setName("");
            setOptions("");
            router.refresh();
          });
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Field name — e.g. How we met"
          className="w-48"
          required
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as CustomFieldKind)}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-[13px]"
        >
          {KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
        {needsOptions && (
          <Input
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            placeholder="Options, comma-separated"
            className="w-56"
          />
        )}
        <Button type="submit" size="sm" disabled={pending || !name.trim()}>
          Add field
        </Button>
      </form>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {fields.length > 0 ? (
        <ul className="space-y-1">
          {fields.map((f) => (
            <li
              key={f.id}
              className="group flex items-center gap-2 rounded-md border border-border/60 px-3 py-1.5 text-[13px]"
            >
              <span className="font-medium">{f.name}</span>
              <span className="text-[11px] text-muted-foreground">
                {KINDS.find((k) => k.kind === f.kind)?.label}
                {f.options.length ? ` · ${f.options.join(", ")}` : ""}
              </span>
              <span className="flex-1" />
              <button
                aria-label={`Delete field ${f.name}`}
                className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    await deleteCustomFieldAction(f.id);
                    router.refresh();
                  })
                }
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          No custom fields yet. They appear on every contact and become
          filterable dimensions.
        </p>
      )}
    </div>
  );
}
