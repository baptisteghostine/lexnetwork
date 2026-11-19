import { describe, expect, it } from "vitest";

import {
  exportMessageKey,
  isWaId,
  keyExportMessages,
  messageFingerprint,
  purgeEligible,
  summarizeDay,
  toWaId,
  waDayKey,
  wantsForLink,
  WA_OVERLAP_MS,
  WA_RETENTION_MS,
  type WaMessage,
} from "@/lib/whatsapp/chat";

// SPEC §15: the WhatsApp rules that need no database.

const DAY = 24 * 60 * 60 * 1000;
const T = Date.UTC(2026, 10, 18, 9, 0, 0);
const msg = (over: Partial<WaMessage> = {}): Omit<WaMessage, "key"> => ({ direction: "inbound", sentAt: T, kind: "text", body: "hello", ...over });

describe("toWaId", () => {
  it("is the number in digits, however it was typed", () => {
    for (const typed of ["+44 7911 123456", "+447911123456", "0044 7911 123456", "07911 123456", " +44 (0)7911-123456 "]) {
      expect(toWaId(typed, "GB"), typed).toBe("447911123456");
    }
    // A range the bundled numbering plan does not know is still accepted
    // when the country code was typed.
    expect(toWaId("+44 7700 900123")).toBe("447700900123");
    expect(toWaId("+33 6 12 34 56 78")).toBe("33612345678");
    expect(toWaId("+1 (415) 555-2671")).toBe("14155552671");
  });

  it("is nothing when it is not a real number — a chat is never guessed", () => {
    for (const bad of ["", "John", "12345", "+44", "07911 123456" /* no region */, "447700900123@s.whatsapp.net", "120363041234567890@g.us"]) {
      expect(toWaId(bad), bad).toBeNull();
    }
    expect(isWaId("447700900123")).toBe(true);
    for (const bad of ["+447700900123", "0447700900123", "12345", "120363041234567890", "447700900123@c.us", 447700900123, null]) {
      expect(isWaId(bad), String(bad)).toBe(false);
    }
  });
});

describe("the same message, seen twice", () => {
  it("fingerprints by direction, second and text — not by milliseconds or spacing", () => {
    expect(messageFingerprint(msg({ sentAt: T + 400, body: "see  you\nthere" }))).toBe(messageFingerprint(msg({ sentAt: T + 900, body: "see you there " })));
    expect(messageFingerprint(msg())).not.toBe(messageFingerprint(msg({ direction: "outbound" })));
    expect(messageFingerprint(msg())).not.toBe(messageFingerprint(msg({ sentAt: T + 1000 })));
    expect(messageFingerprint(msg())).not.toBe(messageFingerprint(msg({ body: "hello!" })));
    expect(messageFingerprint(msg(), { ignoreBody: true })).toBe(messageFingerprint(msg({ body: null, kind: "media" }), { ignoreBody: true }));
  });

  it("gives an export line the same key on every upload, and repeats their own", () => {
    const keyed = keyExportMessages("447700900123", [msg({ body: "ok" }), msg({ body: "ok" }), msg({ body: "ok", sentAt: T + 1000 })]);
    expect(keyed.map((m) => m.key)).toEqual([
      exportMessageKey("447700900123", msg({ body: "ok" }), 0),
      exportMessageKey("447700900123", msg({ body: "ok" }), 1),
      exportMessageKey("447700900123", msg({ body: "ok", sentAt: T + 1000 }), 0),
    ]);
    expect(new Set(keyed.map((m) => m.key)).size).toBe(3);
    expect(keyed[0].key).toMatch(/^export:[0-9a-f]{32}$/);
    // The same line in another person's chat is another message.
    expect(exportMessageKey("33612345678", msg({ body: "ok" }), 0)).not.toBe(keyed[0].key);
  });
});

describe("summarizeDay", () => {
  it("a conversation becomes one row, dated to when the owner last wrote", () => {
    const row = summarizeDay(
      "2026-11-18",
      [
        msg({ sentAt: T, body: "Morning!" }),
        msg({ sentAt: T + 60_000, direction: "outbound", body: "Hi — Thursday at 5?" }),
        msg({ sentAt: T + 120_000, kind: "media", body: null }),
        msg({ sentAt: T + 180_000, body: "Perfect" }),
      ],
      "John"
    );
    expect(row).toEqual({
      day: "2026-11-18",
      sourceKey: "wa-day:2026-11-18",
      count: 4,
      sent: 1,
      received: 3,
      occurredAt: T + 60_000,
      direction: "outbound",
      countsForTouch: true,
      title: "WhatsApp · 4 messages (1 sent, 3 received)",
      transcript: "John: Morning!\nYou: Hi — Thursday at 5?\nJohn: [media]\nJohn: Perfect",
    });
  });

  it("a day the owner only received does not reset the clock", () => {
    const row = summarizeDay("2026-11-18", [msg(), msg({ sentAt: T + 5000 })], "John");
    expect(row).toMatchObject({ direction: "inbound", countsForTouch: false, occurredAt: T + 5000, title: "WhatsApp · 2 messages received" });
    expect(summarizeDay("2026-11-18", [msg({ direction: "outbound" })], "John")).toMatchObject({ countsForTouch: true, title: "WhatsApp · 1 message sent" });
    expect(summarizeDay("2026-11-18", [], "John")).toBeNull();
  });

  it("once the text is purged the row keeps its counts and loses its words", () => {
    const row = summarizeDay("2026-08-01", [msg({ body: null }), msg({ direction: "outbound", body: null, sentAt: T + 1000 })], "John");
    expect(row).toMatchObject({ count: 2, sent: 1, received: 1, transcript: null, countsForTouch: true });
  });

  it("a very long day is cut, and says so", () => {
    const many = Array.from({ length: 400 }, (_, i) => msg({ sentAt: T + i * 1000, body: `message number ${i} with some length to it` }));
    const row = summarizeDay("2026-11-18", many, "John")!;
    expect(row.count).toBe(400);
    expect(row.transcript!.length).toBeLessThanOrEqual(4002);
    expect(row.transcript!.endsWith("\n…")).toBe(true);
  });

  it("days are the owner's days, not UTC's", () => {
    const lateEvening = Date.UTC(2026, 6, 15, 23, 30, 0); // 00:30 on the 16th in London
    expect(waDayKey("Europe/London", lateEvening)).toBe("2026-07-16");
    expect(waDayKey("UTC", lateEvening)).toBe("2026-07-15");
  });
});

describe("wantsForLink — all the collector is ever asked for", () => {
  const link = { waId: "447700900123", syncFrom: null, createdAt: T, collectorCoveredFrom: null, newestCollectorAt: null };

  it("a fresh link asks from when it was linked, or from the date the owner picked", () => {
    expect(wantsForLink(link)).toEqual([{ waId: "447700900123", from: T, to: null }]);
    expect(wantsForLink({ ...link, syncFrom: T - 30 * DAY })).toEqual([{ waId: "447700900123", from: T - 30 * DAY, to: null }]);
  });

  it("once covered, it asks only for the tail — with a short overlap", () => {
    expect(wantsForLink({ ...link, collectorCoveredFrom: T, newestCollectorAt: T + 5 * DAY })).toEqual([
      { waId: "447700900123", from: T + 5 * DAY - WA_OVERLAP_MS, to: null },
    ]);
    // Never earlier than the owner asked for.
    expect(wantsForLink({ ...link, collectorCoveredFrom: T, newestCollectorAt: T + 60_000 })[0].from).toBe(T);
  });

  it("an earlier 'import history from' asks for exactly the missing stretch", () => {
    expect(wantsForLink({ ...link, syncFrom: T - 90 * DAY, collectorCoveredFrom: T, newestCollectorAt: T + 5 * DAY })).toEqual([
      { waId: "447700900123", from: T - 90 * DAY, to: T },
      { waId: "447700900123", from: T + 5 * DAY - WA_OVERLAP_MS, to: null },
    ]);
  });
});

describe("purgeEligible", () => {
  const now = T + 200 * DAY;
  it("needs both: past retention and inside the summary", () => {
    const old = now - WA_RETENTION_MS - DAY;
    expect(purgeEligible(old, old + 1000, now)).toBe(true);
    expect(purgeEligible(old, old, now)).toBe(true);
    // Old but not summarised: kept, however old.
    expect(purgeEligible(old, null, now)).toBe(false);
    expect(purgeEligible(old, old - 1, now)).toBe(false);
    expect(purgeEligible(now - 5 * 365 * DAY, null, now)).toBe(false);
    // Summarised but recent: kept.
    expect(purgeEligible(now - WA_RETENTION_MS + 1000, now, now)).toBe(false);
  });
});
