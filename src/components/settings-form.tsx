"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  updateSettingsAction,
  type AppSettings,
  type SettingsFormState,
} from "@/server/settings";

export function SettingsForm({ initial }: { initial: AppSettings }) {
  const [state, formAction, pending] = useActionState<
    SettingsFormState,
    FormData
  >(updateSettingsAction, {});

  return (
    <form action={formAction} className="max-w-md space-y-5 px-5 py-4">
      <Field
        label="Default phone region"
        hint="2-letter country code (CH, US, DE…) used to parse national-format phone numbers. Leave empty to only accept +international numbers."
      >
        <Input
          name="phoneDefaultRegion"
          defaultValue={initial.phoneDefaultRegion ?? ""}
          placeholder="CH"
          maxLength={2}
          className="w-20 uppercase"
        />
      </Field>
      <Field
        label="Snooze-all horizon (days)"
        hint="“Snooze all” spreads due contacts over at most this many days."
      >
        <Input
          name="snoozeAllHorizonDays"
          type="number"
          min={1}
          max={365}
          defaultValue={initial.snoozeAllHorizonDays}
          className="w-24"
        />
      </Field>
      <Field
        label="Snooze-all per-day floor"
        hint="Minimum contacts scheduled per weekday before the spread widens."
      >
        <Input
          name="snoozeAllPerDayFloor"
          type="number"
          min={1}
          max={50}
          defaultValue={initial.snoozeAllPerDayFloor}
          className="w-24"
        />
      </Field>
      <Field
        label="Digest hour"
        hint="Hour of day (0–23) snoozed contacts come due; the daily digest (later phase) will send at this hour too."
      >
        <Input
          name="digestHour"
          type="number"
          min={0}
          max={23}
          defaultValue={initial.digestHour}
          className="w-24"
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
        {state.error ? (
          <p className="text-xs text-destructive">{state.error}</p>
        ) : state.saved ? (
          <p className="text-xs text-muted-foreground">Saved.</p>
        ) : null}
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[13px]">{label}</Label>
      {children}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}
