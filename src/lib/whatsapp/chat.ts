import { createHash } from "node:crypto";

import { parsePhoneNumberFromString } from "libphonenumber-js";

import { localDateKey } from "@/lib/time";

// WhatsApp per person (SPEC §15): the rules that involve no database.
// Who a chat is (a number, never a name), what makes two records the same
// message, how a day of messages becomes one timeline row, and when text
// may be let go.

export type WaDirection = "inbound" | "outbound";
export const WA_KINDS = ["text", "media", "call", "other"] as const;
export type WaKind = (typeof WA_KINDS)[number];

export type WaMessage = {
  /** WhatsApp's own id for the message, or `export:<hash>` from a phone export. */
  key: string;
  direction: WaDirection;
  /** Epoch milliseconds. */
  sentAt: number;
  kind: WaKind;
  /** Text only. Media never leaves the laptop: it arrives as a kind and no body. */
  body: string | null;
};

export const WA_BODY_MAX = 8000;
export const WA_SAVED_NAME_MAX = 80;

// ---------- identity ----------

/**
 * A WhatsApp identity from a phone number as the owner types it: the
 * number in E.164 digits, no "+". Null when it is not a valid number —
 * Rolo never guesses a chat.
 */
export function toWaId(input: string, defaultRegion?: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // "00" is the international prefix most people type on a keypad.
  const typed = trimmed.replace(/^00/, "+");
  const international = typed.startsWith("+");
  const parsed = parsePhoneNumberFromString(typed, defaultRegion as Parameters<typeof parsePhoneNumberFromString>[1]);
  if (!parsed) return null;
  // A number typed with its country code is taken if it is a possible
  // number for that country: the bundled numbering plans lag behind new
  // ranges, and refusing a real number would leave a chat unlinkable. A
  // national number has to be valid, since the country is being assumed.
  if (!(parsed.isValid() || (international && parsed.isPossible()))) return null;
  const digits = parsed.number.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

export function isWaId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{6,14}$/.test(value);
}

/** "+44 7700 900123" from "447700900123" — for showing, never for matching. */
export function formatWaId(waId: string): string {
  return `+${waId}`;
}

// ---------- the same message, seen twice ----------

function normalizeBody(body: string | null): string {
  return (body ?? "").replace(/\s+/g, " ").trim();
}

/**
 * What two records of one message share whatever their ids: direction,
 * the second it was sent, and its text. A phone export carries no message
 * ids, so this is how an export and the laptop collector agree that they
 * are describing the same message. Text that has been purged matches any
 * text — a re-import must not bring it back.
 */
export function messageFingerprint(m: Pick<WaMessage, "direction" | "sentAt" | "kind" | "body">, opts: { ignoreBody?: boolean } = {}): string {
  const second = Math.floor(m.sentAt / 1000);
  return opts.ignoreBody ? `${m.direction}|${second}` : `${m.direction}|${second}|${m.kind}|${normalizeBody(m.body)}`;
}

/**
 * A stable key for a message that has none of its own (a line of a phone
 * export). `occurrence` tells apart two identical lines in one second.
 */
export function exportMessageKey(waId: string, m: Pick<WaMessage, "direction" | "sentAt" | "kind" | "body">, occurrence: number): string {
  const hash = createHash("sha256")
    .update(`${waId}|${messageFingerprint(m)}|${occurrence}`)
    .digest("hex")
    .slice(0, 32);
  return `export:${hash}`;
}

/** Give every message of a parsed export its key, counting repeats. */
export function keyExportMessages(waId: string, messages: Omit<WaMessage, "key">[]): WaMessage[] {
  const seen = new Map<string, number>();
  return messages.map((m) => {
    const print = messageFingerprint(m);
    const n = seen.get(print) ?? 0;
    seen.set(print, n + 1);
    return { ...m, key: exportMessageKey(waId, m, n) };
  });
}

// ---------- a day of messages as one timeline row ----------

export type WaDayRow = {
  /** Local date, YYYY-MM-DD in the owner's timezone. */
  day: string;
  /** `wa-day:<day>` — the interaction's source_key. */
  sourceKey: string;
  count: number;
  sent: number;
  received: number;
  /** When the owner last wrote that day, else the last message. */
  occurredAt: number;
  direction: WaDirection;
  /** Only what the owner sent resets the keep-in-touch clock (SPEC §3). */
  countsForTouch: boolean;
  title: string;
  /** The day's retained text as a short transcript, or null once purged. */
  transcript: string | null;
};

export const WA_TRANSCRIPT_MAX = 4000;

export function waDayKey(tz: string, sentAt: number): string {
  return localDateKey(tz, sentAt);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * One row for one day of one chat. A conversation is dozens of messages;
 * a timeline is for "we talked on Tuesday", so the day is the unit and
 * the messages sit behind it.
 */
export function summarizeDay(
  day: string,
  messages: Pick<WaMessage, "direction" | "sentAt" | "kind" | "body">[],
  theirName: string
): WaDayRow | null {
  if (messages.length === 0) return null;
  const ordered = [...messages].sort((a, b) => a.sentAt - b.sentAt);
  const sent = ordered.filter((m) => m.direction === "outbound");
  const received = ordered.length - sent.length;
  const last = ordered[ordered.length - 1];
  const lines: string[] = [];
  let used = 0;
  let cut = false;
  for (const m of ordered) {
    const text = m.kind === "text" ? normalizeBody(m.body) : m.kind === "media" ? "[media]" : m.kind === "call" ? "[call]" : "";
    // A text message whose body is gone was purged: it is counted above
    // and left out of the transcript.
    if (!text) continue;
    const line = `${m.direction === "outbound" ? "You" : theirName}: ${text}`;
    if (used + line.length + 1 > WA_TRANSCRIPT_MAX) {
      cut = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  const hasText = ordered.some((m) => m.kind === "text" && normalizeBody(m.body));
  return {
    day,
    sourceKey: `wa-day:${day}`,
    count: ordered.length,
    sent: sent.length,
    received,
    occurredAt: sent.length > 0 ? sent[sent.length - 1].sentAt : last.sentAt,
    direction: sent.length > 0 ? "outbound" : "inbound",
    countsForTouch: sent.length > 0,
    title:
      sent.length > 0 && received > 0
        ? `WhatsApp · ${plural(ordered.length, "message")} (${sent.length} sent, ${received} received)`
        : sent.length > 0
          ? `WhatsApp · ${plural(sent.length, "message")} sent`
          : `WhatsApp · ${plural(received, "message")} received`,
    transcript: hasText ? `${lines.join("\n")}${cut ? "\n…" : ""}` : null,
  };
}

// ---------- what the collector is asked for ----------

export type WaWant = { waId: string; from: number; to: number | null };

/** The collector re-reads this much behind the newest message it delivered. */
export const WA_OVERLAP_MS = 10 * 60 * 1000;

/**
 * The date ranges Rolo wants for one linked chat — the whole of what the
 * laptop is asked to read. History first (from the date the owner picked
 * back to where the collector has already covered), then the live tail.
 */
export function wantsForLink(link: {
  waId: string;
  syncFrom: number | null;
  createdAt: number;
  collectorCoveredFrom: number | null;
  newestCollectorAt: number | null;
}): WaWant[] {
  const from = link.syncFrom ?? link.createdAt;
  if (link.collectorCoveredFrom === null) return [{ waId: link.waId, from, to: null }];
  const wants: WaWant[] = [];
  if (from < link.collectorCoveredFrom) wants.push({ waId: link.waId, from, to: link.collectorCoveredFrom });
  const tail = Math.max(from, (link.newestCollectorAt ?? link.collectorCoveredFrom) - WA_OVERLAP_MS);
  wants.push({ waId: link.waId, from: tail, to: null });
  return wants;
}

// ---------- retention ----------

/** Exact text is kept this long. */
export const WA_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * …and then this much longer once the summary covers it, before it is
 * cleared — time to read a new summary and undo it if it is wrong.
 */
export const WA_PURGE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * May this message's text be scheduled for clearing? Only when it is past
 * retention AND the saved summary reaches at least as far as it. Text is
 * never let go on age alone.
 */
export function purgeEligible(sentAt: number, summaryCoversThrough: number | null, now: number): boolean {
  return summaryCoversThrough !== null && sentAt <= summaryCoversThrough && sentAt < now - WA_RETENTION_MS;
}
