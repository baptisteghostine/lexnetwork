"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuth } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/settings";

// The keys the app reads today (cadence engine, import engine, contact
// form). Digest hour is read by snooze-all slot planning now and by the
// Phase 5 digest job later.
export type AppSettings = {
  phoneDefaultRegion: string | null;
  snoozeAllHorizonDays: number;
  snoozeAllPerDayFloor: number;
  digestHour: number;
};

export async function readAppSettings(): Promise<AppSettings> {
  await requireAuth();
  return {
    phoneDefaultRegion: getSetting<string>("phone_default_region") ?? null,
    snoozeAllHorizonDays: getSetting<number>("snooze_all.horizon_days") ?? 21,
    snoozeAllPerDayFloor: getSetting<number>("snooze_all.per_day_floor") ?? 3,
    digestHour: getSetting<number>("digest.hour") ?? 8,
  };
}

const settingsInput = z.object({
  phoneDefaultRegion: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Region must be a 2-letter country code, e.g. CH.")
    .or(z.literal("")),
  snoozeAllHorizonDays: z.coerce.number().int().min(1).max(365),
  snoozeAllPerDayFloor: z.coerce.number().int().min(1).max(50),
  digestHour: z.coerce.number().int().min(0).max(23),
});

export type SettingsFormState = { error?: string; saved?: boolean };

export async function updateSettingsAction(
  _prev: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  await requireAuth();
  const parsed = settingsInput.safeParse({
    phoneDefaultRegion: formData.get("phoneDefaultRegion") ?? "",
    snoozeAllHorizonDays: formData.get("snoozeAllHorizonDays"),
    snoozeAllPerDayFloor: formData.get("snoozeAllPerDayFloor"),
    digestHour: formData.get("digestHour"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }
  const s = parsed.data;
  setSetting("phone_default_region", s.phoneDefaultRegion || null);
  setSetting("snooze_all.horizon_days", s.snoozeAllHorizonDays);
  setSetting("snooze_all.per_day_floor", s.snoozeAllPerDayFloor);
  setSetting("digest.hour", s.digestHour);
  revalidatePath("/settings");
  return { saved: true };
}
