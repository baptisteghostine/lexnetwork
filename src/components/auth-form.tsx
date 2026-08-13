"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AuthFormState } from "@/server/auth";

type Field = {
  name: string;
  label: string;
  autoFocus?: boolean;
  /** "new-password" on first-run setup, "current-password" when logging in. */
  autoComplete?: "new-password" | "current-password";
};

export function AuthForm({
  action,
  fields,
  submitLabel,
}: {
  action: (prev: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  fields: Field[];
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3">
      {fields.map((f) => (
        <div key={f.name} className="space-y-1.5">
          <Label htmlFor={f.name}>{f.label}</Label>
          <Input
            id={f.name}
            name={f.name}
            type="password"
            autoFocus={f.autoFocus}
            autoComplete={f.autoComplete ?? "current-password"}
            required
          />
        </div>
      ))}
      {state.error ? (
        <p className="text-xs text-destructive">{state.error}</p>
      ) : null}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "…" : submitLabel}
      </Button>
    </form>
  );
}
