import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { fallbackTimezone } from "@/lib/time";

export function getSetting<T>(key: string): T | undefined {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return undefined;
  return JSON.parse(row.value) as T;
}

/** The owner's timezone: the setting, else the server's zone. */
export function ownerTimezone(): string {
  return getSetting<string>("timezone") ?? fallbackTimezone();
}

export function setSetting(key: string, value: unknown): void {
  db.insert(settings)
    .values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(value) },
    })
    .run();
}
