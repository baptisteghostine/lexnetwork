"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ensureDigestJob, ensureSyncJobs } from "@/jobs/scheduler";
import { buildTodayDigest } from "@/jobs/digest";
import { runNetworkUpdates, type NetworkUpdatesResult } from "@/jobs/network-updates";
import { requireAuth } from "@/lib/auth";
import { sendEmail } from "@/lib/digest/send";
import { getSetting, setSetting } from "@/lib/settings";
import { fallbackTimezone } from "@/lib/time";

// The keys the app reads today (cadence engine, import engine, contact
// form, scheduler, digest, birthdays).
export type AppSettings = {
  timezone: string;
  phoneDefaultRegion: string | null;
  snoozeAllHorizonDays: number;
  snoozeAllPerDayFloor: number;
  digestHour: number;
  digestSendWhenEmpty: boolean;
  networkUpdatesEmail: boolean;
  birthdaysFeb29: "feb28" | "mar1";
  birthdaysImportantOnly: boolean;
  appUrl: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpTo: string;
};

type StoredSmtp = {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
  to?: string;
};

export async function readAppSettings(): Promise<AppSettings> {
  await requireAuth();
  const smtp = getSetting<StoredSmtp>("smtp") ?? {};
  return {
    timezone: getSetting<string>("timezone") ?? fallbackTimezone(),
    phoneDefaultRegion: getSetting<string>("phone_default_region") ?? null,
    snoozeAllHorizonDays: getSetting<number>("snooze_all.horizon_days") ?? 21,
    snoozeAllPerDayFloor: getSetting<number>("snooze_all.per_day_floor") ?? 3,
    digestHour: getSetting<number>("digest.hour") ?? 8,
    digestSendWhenEmpty:
      getSetting<boolean>("digest.send_when_empty") ?? false,
    networkUpdatesEmail: getSetting<boolean>("network_updates.email") ?? true,
    birthdaysFeb29: getSetting<"feb28" | "mar1">("birthdays.feb29") ?? "feb28",
    birthdaysImportantOnly:
      getSetting<boolean>("birthdays.important_only") ?? true,
    appUrl: getSetting<string>("app_url") ?? "http://localhost:3000",
    smtpHost: smtp.host ?? "",
    smtpPort: smtp.port ?? 587,
    smtpSecure: smtp.secure ?? false,
    smtpUser: smtp.user ?? "",
    smtpPass: smtp.pass ?? "",
    smtpFrom: smtp.from ?? "",
    smtpTo: smtp.to ?? "",
  };
}

export type SettingsFormState = { error?: string; saved?: boolean };

// Settings save per SECTION (SPEC §12 settings anatomy): each action
// validates and writes only its own keys, so posting one section's form
// can never wipe another section's values — the failure mode a single
// monolithic action invites the moment the form splits into pages.

const generalInput = z.object({
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .refine(
      (tz) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      },
      { message: "Unknown timezone — use an IANA name like Europe/Zurich." }
    ),
  phoneDefaultRegion: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Region must be a 2-letter country code, e.g. CH.")
    .or(z.literal("")),
  appUrl: z.string().trim().url().max(300),
});

export async function updateGeneralAction(
  _prev: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  await requireAuth();
  const parsed = generalInput.safeParse({
    timezone: formData.get("timezone"),
    phoneDefaultRegion: formData.get("phoneDefaultRegion") ?? "",
    appUrl: formData.get("appUrl"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  setSetting("timezone", parsed.data.timezone);
  setSetting("phone_default_region", parsed.data.phoneDefaultRegion || null);
  setSetting("app_url", parsed.data.appUrl);
  // Timezone moves the digest's local send hour — re-aim the pending job.
  ensureDigestJob(Date.now());
  revalidatePath("/settings");
  return { saved: true };
}

const keepInTouchInput = z.object({
  snoozeAllHorizonDays: z.coerce.number().int().min(1).max(365),
  snoozeAllPerDayFloor: z.coerce.number().int().min(1).max(50),
  birthdaysFeb29: z.enum(["feb28", "mar1"]),
  birthdaysImportantOnly: z.coerce.boolean(),
});

export async function updateKeepInTouchAction(
  _prev: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  await requireAuth();
  const parsed = keepInTouchInput.safeParse({
    snoozeAllHorizonDays: formData.get("snoozeAllHorizonDays"),
    snoozeAllPerDayFloor: formData.get("snoozeAllPerDayFloor"),
    birthdaysFeb29: formData.get("birthdaysFeb29"),
    birthdaysImportantOnly: formData.get("birthdaysImportantOnly") === "on",
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const s = parsed.data;
  setSetting("snooze_all.horizon_days", s.snoozeAllHorizonDays);
  setSetting("snooze_all.per_day_floor", s.snoozeAllPerDayFloor);
  setSetting("birthdays.feb29", s.birthdaysFeb29);
  setSetting("birthdays.important_only", s.birthdaysImportantOnly);
  revalidatePath("/settings");
  return { saved: true };
}

const notificationsInput = z.object({
  digestHour: z.coerce.number().int().min(0).max(23),
  digestSendWhenEmpty: z.coerce.boolean(),
  networkUpdatesEmail: z.coerce.boolean(),
  smtpHost: z.string().trim().max(300),
  smtpPort: z.coerce.number().int().min(1).max(65535),
  smtpSecure: z.coerce.boolean(),
  smtpUser: z.string().trim().max(300),
  smtpPass: z.string().max(300),
  smtpFrom: z.string().trim().max(300),
  smtpTo: z.string().trim().max(300),
});

export async function updateNotificationsAction(
  _prev: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  await requireAuth();
  const parsed = notificationsInput.safeParse({
    digestHour: formData.get("digestHour"),
    digestSendWhenEmpty: formData.get("digestSendWhenEmpty") === "on",
    networkUpdatesEmail: formData.get("networkUpdatesEmail") === "on",
    smtpHost: formData.get("smtpHost") ?? "",
    smtpPort: formData.get("smtpPort") || 587,
    smtpSecure: formData.get("smtpSecure") === "on",
    smtpUser: formData.get("smtpUser") ?? "",
    smtpPass: formData.get("smtpPass") ?? "",
    smtpFrom: formData.get("smtpFrom") ?? "",
    smtpTo: formData.get("smtpTo") ?? "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const s = parsed.data;
  setSetting("digest.hour", s.digestHour);
  setSetting("digest.send_when_empty", s.digestSendWhenEmpty);
  setSetting("network_updates.email", s.networkUpdatesEmail);
  setSetting("smtp", {
    host: s.smtpHost,
    port: s.smtpPort,
    secure: s.smtpSecure,
    user: s.smtpUser,
    pass: s.smtpPass,
    from: s.smtpFrom,
    to: s.smtpTo,
  });
  // Digest hour may have moved; SMTP appearing enables the network-updates
  // sweep — both scheduled within a tick, not an interval away.
  ensureDigestJob(Date.now());
  ensureSyncJobs(Date.now());
  revalidatePath("/settings");
  return { saved: true };
}

export type TestDigestState = { error?: string; sent?: boolean };

/** Settings-page button: build the digest for right now and send it,
 * even when empty — you're testing the pipe, not the content. */
export async function sendDigestNowAction(): Promise<TestDigestState> {
  await requireAuth();
  try {
    const email = buildTodayDigest(Date.now());
    await sendEmail(email);
    return { sent: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Send failed." };
  }
}

export type NetworkUpdatesState = {
  error?: string;
  result?: NetworkUpdatesResult;
};

/** Settings-page button: run the network-updates sweep right now. Unlike
 * "Send digest now" this is the real thing, not a test — it stamps what it
 * sends, so the scheduled sweep won't repeat it. That's deliberate: a test
 * that emailed the same news twice would defeat the point of the ledger. */
export async function sendNetworkUpdatesNowAction(): Promise<NetworkUpdatesState> {
  await requireAuth();
  try {
    return { result: await runNetworkUpdates(Date.now()) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Send failed." };
  }
}
