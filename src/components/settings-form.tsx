"use client";

import { useActionState, useMemo, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  sendDigestNowAction,
  updateSettingsAction,
  type AppSettings,
  type SettingsFormState,
} from "@/server/settings";

export function SettingsForm({ initial }: { initial: AppSettings }) {
  const [state, formAction, pending] = useActionState<
    SettingsFormState,
    FormData
  >(updateSettingsAction, {});
  const [testPending, startTest] = useTransition();
  const [testResult, setTestResult] = useState<string | null>(null);

  const timezones = useMemo<string[]>(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [];
    }
  }, []);

  return (
    <form action={formAction} className="max-w-lg space-y-5 px-5 py-4">
      <SectionTitle>General</SectionTitle>
      <Field
        label="Timezone"
        hint="IANA name — drives 'due today', digest send time, and birthdays."
      >
        <Input
          name="timezone"
          defaultValue={initial.timezone}
          list="rolo-timezones"
          className="w-64"
          required
        />
        <datalist id="rolo-timezones">
          {timezones.map((tz) => (
            <option key={tz} value={tz} />
          ))}
        </datalist>
      </Field>
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
        label="App URL"
        hint="Used for links in digest emails (your reverse-proxy address in production)."
      >
        <Input name="appUrl" defaultValue={initial.appUrl} className="w-72" />
      </Field>

      <Separator />
      <SectionTitle>Keep in touch</SectionTitle>
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

      <Separator />
      <SectionTitle>Birthdays</SectionTitle>
      <Field
        label="Feb 29 birthdays"
        hint="Where leap-day birthdays are observed in non-leap years."
      >
        <select
          name="birthdaysFeb29"
          defaultValue={initial.birthdaysFeb29}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-[13px]"
        >
          <option value="feb28">Celebrate Feb 28</option>
          <option value="mar1">Celebrate Mar 1</option>
        </select>
      </Field>
      <CheckboxField
        name="birthdaysImportantOnly"
        defaultChecked={initial.birthdaysImportantOnly}
        label="Important birthdays only"
        hint="Show only starred or previously-contacted people (Dex's noise-control default). Untick for everyone."
      />

      <Separator />
      <SectionTitle>Daily digest</SectionTitle>
      <Field
        label="Digest hour"
        hint="Local hour (0–23) the digest email sends; snoozed contacts also come due at this hour."
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
      <CheckboxField
        name="digestSendWhenEmpty"
        defaultChecked={initial.digestSendWhenEmpty}
        label="Send even when empty"
        hint="Off = no email on all-clear days."
      />
      <div className="grid grid-cols-2 gap-3">
        <Field label="SMTP host" hint="">
          <Input
            name="smtpHost"
            defaultValue={initial.smtpHost}
            placeholder="smtp.fastmail.com"
          />
        </Field>
        <Field label="Port" hint="">
          <Input
            name="smtpPort"
            type="number"
            min={1}
            max={65535}
            defaultValue={initial.smtpPort}
            className="w-24"
          />
        </Field>
        <Field label="SMTP user" hint="">
          <Input name="smtpUser" defaultValue={initial.smtpUser} />
        </Field>
        <Field label="SMTP password" hint="">
          <Input
            name="smtpPass"
            type="password"
            defaultValue={initial.smtpPass}
          />
        </Field>
        <Field label="From" hint="">
          <Input
            name="smtpFrom"
            defaultValue={initial.smtpFrom}
            placeholder="rolo@yourdomain.tld"
          />
        </Field>
        <Field label="To" hint="">
          <Input
            name="smtpTo"
            defaultValue={initial.smtpTo}
            placeholder="you@yourdomain.tld"
          />
        </Field>
      </div>
      <CheckboxField
        name="smtpSecure"
        defaultChecked={initial.smtpSecure}
        label="Implicit TLS (port 465)"
        hint="Off = STARTTLS on 587, the common default."
      />
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={testPending}
          onClick={() =>
            startTest(async () => {
              setTestResult(null);
              const res = await sendDigestNowAction();
              setTestResult(
                res.sent ? "Digest sent — check your inbox." : (res.error ?? "Failed.")
              );
            })
          }
        >
          {testPending ? "Sending…" : "Send digest now"}
        </Button>
        {testResult ? (
          <p className="text-xs text-muted-foreground">{testResult}</p>
        ) : null}
      </div>

      <Separator />
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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
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
      {hint ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function CheckboxField({
  name,
  defaultChecked,
  label,
  hint,
}: {
  name: string;
  defaultChecked: boolean;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-2.5">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-0.5 h-3.5 w-3.5 accent-primary"
      />
      <span>
        <span className="block text-[13px]">{label}</span>
        <span className="block text-[11px] leading-relaxed text-muted-foreground">
          {hint}
        </span>
      </span>
    </label>
  );
}
