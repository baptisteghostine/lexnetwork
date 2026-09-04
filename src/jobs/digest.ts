import { buildDigest, type DigestEmail } from "@/lib/digest/build";
import { sendEmail } from "@/lib/digest/send";
import { getSetting } from "@/lib/settings";
import { getTodayData, ownerTimezone } from "@/server/today-data";
import { DAY_MS } from "@/lib/cadence/engine";

// Digest = the Today page, mailed. Data comes from the same getTodayData
// call the page renders, satisfying the SPEC §3 "matches Today" AC.

export function buildTodayDigest(now: number): DigestEmail {
  const data = getTodayData(now);
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: data.timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(now);
  return buildDigest({
    dateLabel,
    appUrl: getSetting<string>("app_url") ?? "http://localhost:3000",
    reminders: data.reminders.map((r) => ({
      title: r.title,
      contactName: r.contactName,
      overdueDays: Math.max(0, Math.floor((now - r.dueAt) / DAY_MS)),
    })),
    dueContacts: data.dueContacts.map((c) => ({
      displayName: c.displayName,
      title: c.title,
      company: c.company,
      daysOverdue: c.daysOverdue,
      starred: c.starred,
    })),
    changes: data.changes.map((c) => ({
      displayName: c.contactName,
      field: c.field,
      oldValue: c.oldValue,
      newValue: c.newValue,
    })),
    birthdays: data.birthdays.map((b) => ({
      displayName: b.displayName,
      daysUntil: b.daysUntil,
      turns: b.turns,
    })),
    resurface: data.resurface.map((r) => ({
      displayName: r.displayName,
      title: r.title,
      company: r.company,
      monthsSince:
        r.lastInteractionAt === null
          ? null
          : Math.floor((now - r.lastInteractionAt) / (30 * DAY_MS)),
      interactionCount: r.interactionCount,
    })),
  });
}

export type DigestResult = "sent" | "skipped-empty";

export async function runDigest(now: number): Promise<DigestResult> {
  const email = buildTodayDigest(now);
  const sendWhenEmpty = getSetting<boolean>("digest.send_when_empty") ?? false;
  if (email.empty && !sendWhenEmpty) return "skipped-empty";
  await sendEmail(email);
  return "sent";
}

export { ownerTimezone };
