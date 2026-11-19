"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authorizeAction, type ConsentState } from "@/server/agent/consent";

// The connector's consent screen form (SPEC §14): the owner's password is
// both the proof of who is approving and the approval itself. The request
// travels as hidden fields and is validated again on the server — nothing
// here is trusted.

export function ConsentForm({
  params,
  denyHref,
}: {
  /** The authorization request exactly as it arrived. */
  params: Record<string, string>;
  /** Where "Deny" goes: the client's own redirect, with access_denied. */
  denyHref: string;
}) {
  const [state, formAction, pending] = useActionState<ConsentState, FormData>(authorizeAction, {});
  return (
    <form action={formAction} className="space-y-3">
      {Object.entries(params).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name="decision" value="allow" />
      <div className="space-y-1.5">
        <Label htmlFor="password">Your Rolo password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          required
        />
      </div>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" className="flex-1" disabled={pending}>
          {pending ? "…" : "Allow"}
        </Button>
        <Button asChild variant="outline" className="flex-1">
          <a href={denyHref}>Deny</a>
        </Button>
      </div>
    </form>
  );
}
