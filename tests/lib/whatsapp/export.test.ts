import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";

import { assignDirections, exportTextFromUpload, parseWhatsAppExport } from "@/lib/whatsapp/export";

// SPEC §15: the phone's "Export chat" file. Real exports carry invisible
// direction marks and, on a 12-hour phone, a narrow no-break space before
// AM/PM; they are built here from character codes so this file holds none.

const LRM = String.fromCharCode(0x200e);
const NNBSP = String.fromCharCode(0x202f);
const TZ = "Europe/London";
const at = (iso: string) => Date.parse(iso);

function ok(text: string, tz = TZ) {
  const parsed = parseWhatsAppExport(text, tz);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed;
}

const IPHONE = [
  `[18/11/2026, 09:15:02] John: ${LRM}Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them.`,
  "[18/11/2026, 09:15:02] John: Morning! Still on for Thursday?",
  "[18/11/2026, 09:16:40] Baptiste G: Yes — 5pm at the usual place",
  "Bring the deck if you can",
  "",
  "second paragraph of the same message",
  `${LRM}[18/11/2026, 09:17:05] John: ${LRM}<attached: 00000012-PHOTO-2026-11-18-09-17-05.jpg>`,
  `[18/11/2026, 09:17:30] John: ${LRM}image omitted`,
  `[18/11/2026, 09:18:00] Baptiste G: ${LRM}You deleted this message.`,
  `[18/11/2026, 09:19:00] John: ${LRM}Missed voice call`,
  `[19/11/2026, 21:02:11] John: Running late ${LRM}<This message was edited>`,
  "[19/11/2026, 21:02:11] John: ok",
  "[19/11/2026, 21:02:11] John: ok",
].join("\r\n");

describe("parseWhatsAppExport — iPhone", () => {
  it("reads messages, multi-line text, and what is not text", () => {
    const parsed = ok(IPHONE);
    expect(parsed).toMatchObject({ format: "iphone", dateOrder: "day/month", dateOrderAssumed: false, skipped: 1 });
    expect(parsed.senders).toEqual([
      { name: "John", messages: 7 },
      { name: "Baptiste G", messages: 2 },
    ]);
    expect(parsed.lines.map((l) => [l.sender, l.kind, l.body])).toEqual([
      ["John", "text", "Morning! Still on for Thursday?"],
      ["Baptiste G", "text", "Yes — 5pm at the usual place\nBring the deck if you can\nsecond paragraph of the same message"],
      ["John", "media", null],
      ["John", "media", null],
      ["Baptiste G", "other", null],
      ["John", "call", null],
      ["John", "text", "Running late"],
      ["John", "text", "ok"],
      ["John", "text", "ok"],
    ]);
    // November: London is on GMT, so the wall clock is UTC.
    expect(parsed.lines[0].sentAt).toBe(at("2026-11-18T09:15:02Z"));
    expect(parsed.firstAt).toBe(at("2026-11-18T09:15:02Z"));
    expect(parsed.lastAt).toBe(at("2026-11-19T21:02:11Z"));
  });

  it("places wall-clock times in the phone's timezone, across summer time", () => {
    const summer = ok("[15/07/2026, 18:30:00] John: Summer\n[15/01/2026, 18:30:00] John: Winter");
    expect(summer.lines.map((l) => new Date(l.sentAt).toISOString())).toEqual([
      "2026-07-15T17:30:00.000Z",
      "2026-01-15T18:30:00.000Z",
    ]);
    expect(ok("[15/07/2026, 18:30:00] John: Summer", "America/New_York").lines[0].sentAt).toBe(at("2026-07-15T22:30:00Z"));
    expect(ok("[15/07/2026, 18:30:00] John: Summer", "UTC").lines[0].sentAt).toBe(at("2026-07-15T18:30:00Z"));
  });

  it("reads a 12-hour phone, two-digit years, and dots for separators", () => {
    const us = ok(`[11/19/26, 2:03:22${NNBSP}PM] John: Afternoon\n[11/19/26, 12:00:05${NNBSP}AM] John: Midnight\n[11/19/26, 12:30:00 pm] John: Lunch`, "UTC");
    expect(us.dateOrder).toBe("month/day");
    expect(us.lines.map((l) => new Date(l.sentAt).toISOString())).toEqual([
      "2026-11-19T14:03:22.000Z",
      "2026-11-19T00:00:05.000Z",
      "2026-11-19T12:30:00.000Z",
    ]);
    const de = ok("[19.11.26, 14:03:22] John: Hallo", "UTC");
    expect(de.lines[0].sentAt).toBe(at("2026-11-19T14:03:22Z"));
    expect(ok("[2026-11-19, 14:03:22] John: ISO", "UTC")).toMatchObject({ dateOrder: "year first" });
  });

  it("when no day is above 12, the order that keeps the file in time order wins", () => {
    // 03/04 then 05/04 then 06/01: as day/month that is 3 Apr, 5 Apr, 6 Jan
    // (goes backwards); as month/day it is 4 Mar, 4 May, 1 Jun (in order).
    const mdy = ok("[03/04/2026, 10:00:00] John: a\n[05/04/2026, 10:00:00] John: b\n[06/01/2026, 10:00:00] John: c", "UTC");
    expect(mdy).toMatchObject({ dateOrder: "month/day", dateOrderAssumed: false });
    const dmy = ok("[03/04/2026, 10:00:00] John: a\n[05/04/2026, 10:00:00] John: b\n[01/06/2026, 10:00:00] John: c", "UTC");
    expect(dmy).toMatchObject({ dateOrder: "day/month", dateOrderAssumed: false });
    // One line cannot say: day/month is assumed, and the result says so.
    expect(ok("[03/04/2026, 10:00:00] John: a", "UTC")).toMatchObject({ dateOrder: "day/month", dateOrderAssumed: true });
  });

  it("a colon inside the message is not a sender", () => {
    const parsed = ok("[18/11/2026, 09:15:02] John: Agenda: budget, hiring: two roles");
    expect(parsed.lines[0]).toMatchObject({ sender: "John", body: "Agenda: budget, hiring: two roles" });
    // A line that merely looks like a date in the middle of a message stays in it.
    const quoted = ok("[18/11/2026, 09:15:02] John: He wrote\nat 10/11/2026 that it was fine");
    expect(quoted.lines).toHaveLength(1);
    expect(quoted.lines[0].body).toBe("He wrote\nat 10/11/2026 that it was fine");
  });

  it("refuses what is not an export, and impossible dates", () => {
    expect(parseWhatsAppExport("Dear John,\nthis is a letter.", TZ)).toEqual({ ok: false, error: expect.stringMatching(/does not look like a WhatsApp chat export/) });
    expect(parseWhatsAppExport("", TZ).ok).toBe(false);
    expect(parseWhatsAppExport(`[18/11/2026, 09:15:02] John: ${LRM}image omitted`, TZ).ok).toBe(true);
    const odd = ok("[31/02/2026, 09:15:02] John: no such day\n[18/11/2026, 25:00:00] John: no such hour\n[18/11/2026, 09:15:02] John: fine");
    expect(odd.lines.map((l) => l.body)).toEqual(["fine"]);
    expect(odd.skipped).toBe(2);
  });

  it("cuts a very long message rather than refusing the file", () => {
    const parsed = ok(`[18/11/2026, 09:15:02] John: ${"x".repeat(20_000)}`);
    expect(parsed.lines[0].body).toHaveLength(8000);
  });
});

describe("parseWhatsAppExport — Android", () => {
  it("reads the bracketless form and skips WhatsApp's own lines", () => {
    const parsed = ok(
      [
        "19/11/2026, 14:03 - Messages and calls are end-to-end encrypted. Tap to learn more.",
        "19/11/2026, 14:03 - John: Hello",
        "19/11/2026, 14:04 - Baptiste G: <Media omitted>",
        "19/11/2026, 14:05 - John: This message was deleted",
      ].join("\n"),
      "UTC"
    );
    expect(parsed).toMatchObject({ format: "android", skipped: 1 });
    expect(parsed.lines.map((l) => [l.sender, l.kind, l.body])).toEqual([
      ["John", "text", "Hello"],
      ["Baptiste G", "media", null],
      ["John", "other", null],
    ]);
    expect(parsed.lines[0].sentAt).toBe(at("2026-11-19T14:03:00Z"));
  });
});

describe("assignDirections", () => {
  it("the name the owner saved them under is them; the other sender is the owner", () => {
    const res = assignDirections(ok(IPHONE), "  john ");
    if (!res.ok) throw new Error("expected ok");
    expect(res.messages.map((m) => m.direction)).toEqual([
      "inbound", "outbound", "inbound", "inbound", "outbound", "inbound", "inbound", "inbound", "inbound",
    ]);
  });

  it("asks rather than guesses when the saved name is not in the file", () => {
    expect(assignDirections(ok(IPHONE), "Chris Haswani")).toEqual({ ok: false, reason: "who", senders: ["John", "Baptiste G"] });
  });

  it("a file with three voices is a group chat, and is refused", () => {
    const group = ok("[18/11/2026, 09:00:00] John: a\n[18/11/2026, 09:01:00] Maya: b\n[18/11/2026, 09:02:00] Baptiste G: c");
    expect(assignDirections(group, "John")).toEqual({ ok: false, reason: "group", senders: ["John", "Maya", "Baptiste G"] });
  });

  it("a one-sided chat still works: everything is theirs, or everything is the owner's", () => {
    const onlyThem = assignDirections(ok("[18/11/2026, 09:00:00] John: hello?"), "John");
    expect(onlyThem.ok && onlyThem.messages[0].direction).toBe("inbound");
    expect(assignDirections(ok("[18/11/2026, 09:00:00] Baptiste G: hello?"), "John")).toMatchObject({ ok: false, reason: "who" });
  });
});

describe("exportTextFromUpload", () => {
  it("takes a .txt as it is, and the chat text out of a zip — never the media", () => {
    expect(exportTextFromUpload(strToU8(IPHONE), "_chat.txt")).toEqual({ ok: true, text: IPHONE });
    const zip = zipSync({
      "00000012-PHOTO-2026-11-18-09-17-05.jpg": new Uint8Array([0xff, 0xd8, 0xff]),
      "_chat.txt": strToU8(IPHONE),
    });
    expect(exportTextFromUpload(zip, "WhatsApp Chat - John.zip")).toEqual({ ok: true, text: IPHONE });
    expect(exportTextFromUpload(zipSync({ "photo.jpg": new Uint8Array([1]) }), "x.zip")).toEqual({ ok: false, error: "The zip holds no chat text (_chat.txt)." });
    expect(exportTextFromUpload(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), "broken.zip").ok).toBe(false);
  });
});
