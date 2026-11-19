import { unzipSync } from "fflate";

import { fromFakeUtc } from "@/lib/time";
import type { WaDirection, WaKind, WaMessage } from "@/lib/whatsapp/chat";
import { WA_BODY_MAX } from "@/lib/whatsapp/chat";

// The phone's "Export chat" file (SPEC §15): WhatsApp's own, official way
// to hand over one conversation. iPhone writes
//
//   [19/11/2026, 14:03:22] John: See you Thursday
//
// (inside a zip, as _chat.txt); Android writes
//
//   19/11/2026, 14:03 - John: See you Thursday
//
// The date's order and the 12/24-hour clock follow the phone's region, and
// there are no message ids. Dependency note: fflate (already used for the
// LinkedIn ZIP) opens the archive.

/** Marks WhatsApp sprinkles into exports: direction marks and a BOM. */
const INVISIBLE = [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x2068, 0x2069, 0xfeff].map((c) => String.fromCharCode(c));
/** Spaces that are not the space bar's (iOS puts one before "PM"). */
const ODD_SPACES = [0x00a0, 0x202f, 0x2009].map((c) => String.fromCharCode(c));

function tidy(line: string): string {
  let out = line;
  for (const mark of INVISIBLE) out = out.replaceAll(mark, "");
  for (const space of ODD_SPACES) out = out.replaceAll(space, " ");
  return out;
}

const DATE = String.raw`(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})`;
const TIME = String.raw`(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?: ?([AaPp])\.? ?[Mm]\.?)?`;
const IOS_LINE = new RegExp(String.raw`^\[${DATE},? ${TIME}\] (.*)$`);
const ANDROID_LINE = new RegExp(String.raw`^${DATE},? ${TIME} - (.*)$`);

type RawLine = {
  a: number;
  b: number;
  c: number;
  aDigits: number;
  hour: number;
  minute: number;
  second: number;
  meridiem: "a" | "p" | null;
  sender: string | null;
  text: string;
};

export type ExportParse =
  | {
      ok: true;
      /** Everyone who wrote in the file, most messages first. */
      senders: { name: string; messages: number }[];
      /** Messages by sender name; direction is decided by the caller. */
      lines: { sender: string; sentAt: number; kind: WaKind; body: string | null }[];
      format: "iphone" | "android";
      dateOrder: "day/month" | "month/day" | "year first";
      /** Neither order could be ruled out; day/month was assumed. */
      dateOrderAssumed: boolean;
      firstAt: number;
      lastAt: number;
      skipped: number;
    }
  | { ok: false; error: string };

const MEDIA = /^(?:<attached: .*>|<Media omitted>|(?:image|video|audio|sticker|GIF|document|Contact card|Location|Poll) omitted|.*\bomitted)$/i;
const CALL = /\b(?:voice|video) call\b/i;
const DELETED = /^(?:This message was deleted\.?|You deleted this message\.?)$/i;
const NOTICE = /^(?:Messages and calls are end-to-end encrypted|Your security code with|.* changed their phone number|You blocked this contact|You unblocked this contact|Disappearing messages|.* turned (?:on|off) disappearing messages|You turned (?:on|off) disappearing messages)/i;
const EDITED = / ?<This message was edited>$/i;

function classifyText(text: string): { kind: WaKind; body: string | null } | null {
  const clean = text.replace(EDITED, "").trim();
  if (!clean) return null;
  if (NOTICE.test(clean)) return null;
  if (DELETED.test(clean)) return { kind: "other", body: null };
  if (MEDIA.test(clean)) return { kind: "media", body: null };
  if (CALL.test(clean) && clean.length < 60) return { kind: "call", body: null };
  return { kind: "text", body: clean.length > WA_BODY_MAX ? `${clean.slice(0, WA_BODY_MAX - 1)}…` : clean };
}

function toEpoch(raw: RawLine, order: "dmy" | "mdy" | "ymd", tz: string): number | null {
  let year: number;
  let month: number;
  let day: number;
  if (order === "ymd") [year, month, day] = [raw.a, raw.b, raw.c];
  else if (order === "dmy") [day, month, year] = [raw.a, raw.b, raw.c];
  else [month, day, year] = [raw.a, raw.b, raw.c];
  if (year < 100) year += 2000;
  let hour = raw.hour;
  if (raw.meridiem === "p" && hour < 12) hour += 12;
  if (raw.meridiem === "a" && hour === 12) hour = 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || raw.minute > 59 || raw.second > 59) return null;
  const fake = Date.UTC(year, month - 1, day, hour, raw.minute, raw.second);
  // A date the calendar does not have (31 February) rolls over; refuse it.
  if (new Date(fake).getUTCDate() !== day) return null;
  return fromFakeUtc(tz, fake);
}

function disorder(times: (number | null)[]): number {
  let breaks = 0;
  let previous = -Infinity;
  for (const t of times) {
    if (t === null) {
      breaks += 1;
      continue;
    }
    if (t < previous) breaks += 1;
    previous = Math.max(previous, t);
  }
  return breaks;
}

/**
 * Read an exported chat. `tz` is the timezone the phone was in — the file
 * holds wall-clock times with no zone, so this cannot be detected.
 */
export function parseWhatsAppExport(text: string, tz: string): ExportParse {
  const raws: RawLine[] = [];
  let format: "iphone" | "android" | null = null;
  let skipped = 0;
  for (const original of text.split(/\r?\n/)) {
    const line = tidy(original);
    const match = IOS_LINE.exec(line) ?? ANDROID_LINE.exec(line);
    if (!match) {
      // Not the start of a message: the rest of the one before it.
      const last = raws[raws.length - 1];
      if (last && line.trim()) last.text += `\n${line}`;
      continue;
    }
    format ??= IOS_LINE.test(line) ? "iphone" : "android";
    const rest = match[8];
    const split = rest.indexOf(": ");
    // No "Name: " means WhatsApp itself is speaking ("You created this group").
    const sender = split > 0 ? rest.slice(0, split).trim() : null;
    raws.push({
      a: Number(match[1]),
      b: Number(match[2]),
      c: Number(match[3]),
      aDigits: match[1].length,
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: match[6] ? Number(match[6]) : 0,
      meridiem: match[7] ? (match[7].toLowerCase() as "a" | "p") : null,
      sender,
      text: split > 0 ? rest.slice(split + 2) : rest,
    });
  }
  if (raws.length === 0 || format === null) {
    return { ok: false, error: "This does not look like a WhatsApp chat export. Use Export chat on your phone and upload the .zip or the _chat.txt inside it." };
  }

  // Which way round is the date? A four-digit first part settles it; so
  // does any day above 12. Failing both, the order that keeps the file in
  // time order wins — an export is always oldest first.
  let order: "dmy" | "mdy" | "ymd";
  let assumed = false;
  if (raws.some((r) => r.aDigits === 4)) {
    order = "ymd";
  } else if (raws.some((r) => r.a > 12)) {
    order = "dmy";
  } else if (raws.some((r) => r.b > 12)) {
    order = "mdy";
  } else {
    const asDmy = disorder(raws.map((r) => toEpoch(r, "dmy", tz)));
    const asMdy = disorder(raws.map((r) => toEpoch(r, "mdy", tz)));
    order = asMdy < asDmy ? "mdy" : "dmy";
    assumed = asDmy === asMdy;
  }

  const lines: { sender: string; sentAt: number; kind: WaKind; body: string | null }[] = [];
  const counts = new Map<string, number>();
  for (const raw of raws) {
    if (raw.sender === null) {
      skipped += 1;
      continue;
    }
    const at = toEpoch(raw, order, tz);
    const what = classifyText(raw.text);
    if (at === null || what === null) {
      skipped += 1;
      continue;
    }
    lines.push({ sender: raw.sender, sentAt: at, ...what });
    counts.set(raw.sender, (counts.get(raw.sender) ?? 0) + 1);
  }
  if (lines.length === 0) return { ok: false, error: "The export holds no messages." };
  const senders = [...counts.entries()].map(([name, messages]) => ({ name, messages })).sort((x, y) => y.messages - x.messages);
  return {
    ok: true,
    senders,
    lines,
    format,
    dateOrder: order === "ymd" ? "year first" : order === "dmy" ? "day/month" : "month/day",
    dateOrderAssumed: assumed,
    firstAt: Math.min(...lines.map((l) => l.sentAt)),
    lastAt: Math.max(...lines.map((l) => l.sentAt)),
    skipped,
  };
}

/** The chat text out of an upload: the .txt itself, or the one inside the zip. */
export function exportTextFromUpload(bytes: Uint8Array, fileName: string): { ok: true; text: string } | { ok: false; error: string } {
  const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) return { ok: true, text: new TextDecoder("utf-8").decode(bytes) };
  let entries: Record<string, Uint8Array>;
  try {
    // Only text is unpacked; photos and voice notes in the archive are
    // never read into memory.
    entries = unzipSync(bytes, { filter: (file) => /\.txt$/i.test(file.name) && file.originalSize < 60 * 1024 * 1024 });
  } catch {
    return { ok: false, error: `${fileName || "The file"} could not be opened as a zip.` };
  }
  const names = Object.keys(entries);
  const chat = names.find((n) => /(^|\/)_chat\.txt$/i.test(n)) ?? names.find((n) => /WhatsApp Chat/i.test(n)) ?? names[0];
  if (!chat) return { ok: false, error: "The zip holds no chat text (_chat.txt)." };
  return { ok: true, text: new TextDecoder("utf-8").decode(entries[chat]) };
}

export type ExportAssignment =
  | { ok: true; messages: Omit<WaMessage, "key">[] }
  | { ok: false; reason: "group"; senders: string[] }
  | { ok: false; reason: "who"; senders: string[] };

/**
 * Decide who is who. The file names people as the phone's address book
 * does, so the contact appears under the name the owner saved them as —
 * which the owner told Rolo when linking. That one name is "them";
 * the other sender is the owner. No name is ever used to find the person.
 */
export function assignDirections(
  parsed: Extract<ExportParse, { ok: true }>,
  theirName: string
): ExportAssignment {
  const names = parsed.senders.map((s) => s.name);
  if (names.length > 2) return { ok: false, reason: "group", senders: names };
  const wanted = theirName.trim().toLowerCase();
  const them = names.find((n) => n.trim().toLowerCase() === wanted);
  if (!them) return { ok: false, reason: "who", senders: names };
  return {
    ok: true,
    messages: parsed.lines.map((l) => ({
      direction: (l.sender === them ? "inbound" : "outbound") as WaDirection,
      sentAt: l.sentAt,
      kind: l.kind,
      body: l.body,
    })),
  };
}
