"use client";

import { useActionState, useMemo, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  sendDigestNowAction,
  sendNetworkUpdatesNowAction,
  updateGeneralAction,
  updateKeepInTouchAction,
  updateNotificationsAction,
  type AppSettings,
  type SettingsFormState,
} from "@/server/settings";

// Settings sections in the Dex anatomy (SPEC §12): each section is a card
// of rows — what it is and why on the left, the control on the right —
// with its own save. One form per section pairs with one action per
// section server-side; see server/settings.ts for why that split matters.

// ---------- shared row primitives ----------

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-border rounded-xl border border-border bg-card/40">
      {children}
    </div>
  );
}

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{label}</p>
        {description ? (
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Toggle({
  name,
  defaultChecked,
}: {
  name: string;
  defaultChecked: boolean;
}) {
  return (
    <input
      type="checkbox"
      name={name}
      defaultChecked={defaultChecked}
      className="h-4 w-4 accent-primary"
    />
  );
}

/** Card footer: the section's save button + outcome, right-aligned. */
function SaveRow({
  pending,
  state,
}: {
  pending: boolean;
  state: SettingsFormState;
}) {
  return (
    <div className="flex items-center justify-end gap-3 px-4 py-2.5">
      {state.error ? (
        <p className="text-xs text-destructive">{state.error}</p>
      ) : state.saved ? (
        <p className="text-xs text-muted-foreground">Saved.</p>
      ) : null}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

// ---------- General ----------

export function GeneralSettings({ initial }: { initial: AppSettings }) {
  const [state, formAction, pending] = useActionState<
    SettingsFormState,
    FormData
  >(updateGeneralAction, {});
  const timezones = useMemo<string[]>(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [];
    }
  }, []);
  return (
    <form action={formAction}>
      <Card>
        <Row
          label="Timezone"
          description="Drives “due today”, the digest send hour, and birthdays."
        >
          <Input
            name="timezone"
            defaultValue={initial.timezone}
            list="rolo-timezones"
            className="w-56"
            required
          />
          <datalist id="rolo-timezones">
            {timezones.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </Row>
        <Row
          label="Default phone region"
          description="2-letter country code used to parse national-format numbers; empty accepts only +international."
        >
          <Input
            name="phoneDefaultRegion"
            defaultValue={initial.phoneDefaultRegion ?? ""}
            placeholder="CH"
            maxLength={2}
            className="w-16 uppercase"
          />
        </Row>
        <Row
          label="App URL"
          description="Used for links in emails — your reverse-proxy address in production."
        >
          <Input name="appUrl" defaultValue={initial.appUrl} className="w-64" />
        </Row>
        <SaveRow pending={pending} state={state} />
      </Card>
    </form>
  );
}

// ---------- Keep in touch ----------

export function KeepInTouchSettings({ initial }: { initial: AppSettings }) {
  const [state, formAction, pending] = useActionState<
    SettingsFormState,
    FormData
  >(updateKeepInTouchAction, {});
  return (
    <form action={formAction}>
      <Card>
        <Row
          label="Snooze-all horizon"
          description="“Snooze all” spreads due contacts over at most this many days."
        >
          <Input
            name="snoozeAllHorizonDays"
            type="number"
            min={1}
            max={365}
            defaultValue={initial.snoozeAllHorizonDays}
            className="w-20"
          />
          <span className="text-xs text-muted-foreground">days</span>
        </Row>
        <Row
          label="Snooze-all per-day floor"
          description="Minimum contacts scheduled per weekday before the spread widens."
        >
          <Input
            name="snoozeAllPerDayFloor"
            type="number"
            min={1}
            max={50}
            defaultValue={initial.snoozeAllPerDayFloor}
            className="w-20"
          />
        </Row>
        <Row
          label="Feb 29 birthdays"
          description="Where leap-day birthdays are observed in non-leap years."
        >
          <select
            name="birthdaysFeb29"
            defaultValue={initial.birthdaysFeb29}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-[13px]"
          >
            <option value="feb28">Celebrate Feb 28</option>
            <option value="mar1">Celebrate Mar 1</option>
          </select>
        </Row>
        <Row
          label="Important birthdays only"
          description="Show only starred or previously-contacted people. Untick for everyone."
        >
          <Toggle
            name="birthdaysImportantOnly"
            defaultChecked={initial.birthdaysImportantOnly}
          />
        </Row>
        <SaveRow pending={pending} state={state} />
      </Card>
    </form>
  );
}

// ---------- Notifications (digest + network updates + SMTP) ----------

export function NotificationSettings({ initial }: { initial: AppSettings }) {
  const [state, formAction, pending] = useActionState<
    SettingsFormState,
    FormData
  >(updateNotificationsAction, {});
  const [testPending, startTest] = useTransition();
  const [testResult, setTestResult] = useState<string | null>(null);
  const [updatesPending, startUpdates] = useTransition();
  const [updatesResult, setUpdatesResult] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <form action={formAction}>
        <Card>
          <Row
            label="Daily digest hour"
            description="Local hour (0–23) the digest email sends; snoozed contacts also come due at this hour."
          >
            <Input
              name="digestHour"
              type="number"
              min={0}
              max={23}
              defaultValue={initial.digestHour}
              className="w-20"
            />
          </Row>
          <Row
            label="Send even when empty"
            description="Off = no email on all-clear days."
          >
            <Toggle
              name="digestSendWhenEmpty"
              defaultChecked={initial.digestSendWhenEmpty}
            />
          </Row>
          <Row
            label="Email me when people change jobs"
            description="Sent within 15 minutes of an import spotting a move, once per change — separate from the digest."
          >
            <Toggle
              name="networkUpdatesEmail"
              defaultChecked={initial.networkUpdatesEmail}
            />
          </Row>
          <Row
            label="Pre-meeting brief"
            description="Before a calendar meeting with someone in Rolo: last touch, open reminders, job changes, your notes, and AI talking points when AI is on. Shows on Today under the agenda."
          >
            <Toggle
              name="meetingPrepEnabled"
              defaultChecked={initial.meetingPrepEnabled}
            />
          </Row>
          <Row
            label="Brief lead time (minutes)"
            description="How far ahead of the meeting the brief is built and sent. 15–1440."
          >
            <Input
              name="meetingPrepLeadMinutes"
              type="number"
              min={15}
              max={1440}
              defaultValue={initial.meetingPrepLeadMinutes}
              className="w-24"
            />
          </Row>
          <Row
            label="Email the brief"
            description="Off = Today only, no email. Needs SMTP either way to send."
          >
            <Toggle
              name="meetingPrepEmail"
              defaultChecked={initial.meetingPrepEmail}
            />
          </Row>
          <Row
            label="Worth reconnecting"
            description="A few people a day with no cadence but real history you've drifted from — on Today and in the digest. Rotates; each person comes round at most every few months."
          >
            <Toggle
              name="resurfaceEnabled"
              defaultChecked={initial.resurfaceEnabled}
            />
          </Row>
          <Row
            label="Picks per day"
            description="1–10."
          >
            <Input
              name="resurfacePerDay"
              type="number"
              min={1}
              max={10}
              defaultValue={initial.resurfacePerDay}
              className="w-20"
            />
          </Row>
          <div className="space-y-3 px-4 py-3">
            <div>
              <p className="text-[13px] font-medium">SMTP</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                The account both emails send through. For Gmail:
                smtp.gmail.com, port 587, your address, and an app password.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <Input
                name="smtpHost"
                defaultValue={initial.smtpHost}
                placeholder="smtp.fastmail.com"
                aria-label="SMTP host"
              />
              <Input
                name="smtpPort"
                type="number"
                min={1}
                max={65535}
                defaultValue={initial.smtpPort}
                aria-label="SMTP port"
              />
              <Input
                name="smtpUser"
                defaultValue={initial.smtpUser}
                placeholder="user"
                aria-label="SMTP user"
              />
              <Input
                name="smtpPass"
                type="password"
                defaultValue={initial.smtpPass}
                placeholder="password"
                aria-label="SMTP password"
              />
              <Input
                name="smtpFrom"
                defaultValue={initial.smtpFrom}
                placeholder="From: rolo@yourdomain.tld"
                aria-label="From address"
              />
              <Input
                name="smtpTo"
                defaultValue={initial.smtpTo}
                placeholder="To: you@yourdomain.tld"
                aria-label="To address"
              />
            </div>
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                name="smtpSecure"
                defaultChecked={initial.smtpSecure}
                className="h-3.5 w-3.5 accent-primary"
              />
              Implicit TLS (port 465) — off = STARTTLS on 587, the common
              default
            </label>
          </div>
          <SaveRow pending={pending} state={state} />
        </Card>
      </form>

      <Card>
        <Row
          label="Send digest now"
          description="Sends today's digest immediately, even when empty — tests the pipe, not the content."
        >
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
                  res.sent
                    ? "Digest sent — check your inbox."
                    : (res.error ?? "Failed.")
                );
              })
            }
          >
            {testPending ? "Sending…" : "Send"}
          </Button>
        </Row>
        {testResult ? (
          <p className="px-4 py-2 text-xs text-muted-foreground">{testResult}</p>
        ) : null}
        <Row
          label="Send network updates now"
          description="Runs the real sweep — whatever it sends is marked told and won't repeat."
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={updatesPending}
            onClick={() =>
              startUpdates(async () => {
                setUpdatesResult(null);
                const res = await sendNetworkUpdatesNowAction();
                setUpdatesResult(
                  res.error ??
                    (res.result === "sent"
                      ? "Sent — check your inbox."
                      : res.result === "disabled"
                        ? "Turn the job-changes toggle on and save first."
                        : "Nothing new to send — no unreported job changes right now.")
                );
              })
            }
          >
            {updatesPending ? "Sending…" : "Send"}
          </Button>
        </Row>
        {updatesResult ? (
          <p className="px-4 py-2 text-xs text-muted-foreground">
            {updatesResult}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
