import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

// The collector's read-only IndexedDB reader (SPEC §15) and the second
// feasibility probe built on it.
//
// The fixture is a real store: written by Chromium 153 through
// IndexedDB, in a page shaped like WhatsApp Web's — a "message" table
// whose text sits in an AES-CBC envelope, and the non-exportable
// WebCrypto key for it in another database. Nothing in it is anyone's
// data. It holds an update and a delete, so "latest write wins" is part
// of what is read back.

import { openIndexedDb, readIdbKey, readLevelDb, readTable, readVarint, snappyDecompress } from "../../collector/idb.mjs";
import { addressClass, kindOf, mask, plaintextKind, shapeOf } from "../../collector/inspect.mjs";

const FIXTURE = path.join(__dirname, "../fixtures/whatsapp-idb/https_web.whatsapp.test_0.indexeddb.leveldb");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rolo-idb-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

type Rec = { key: unknown; read: () => { value?: Record<string, unknown>; error?: string; external?: boolean; wireVersion?: number } };
const all = (idb: { records: (db: string, store: string) => Iterable<Rec> }, db: string, store: string) => [...idb.records(db, store)];

describe("a real Chromium IndexedDB store", () => {
  const idb = openIndexedDb(FIXTURE);

  it("lists the databases, their tables and how many records each holds", () => {
    expect(idb.stats).toMatchObject({ tables: 0, logs: 1, unreadable: [] });
    const shape = idb.databases.map((db: { name: string; origin: string; stores: Map<number, { name: string; records: unknown[] }> }) => [
      db.name,
      [...db.stores.values()].map((s) => [s.name, s.records.length]),
    ]);
    expect(shape).toEqual([
      ["wawc_db_enc", [["keys", 3]]],
      ["model-storage", [["message", 41], ["chat", 2], ["contact", 1], ["counter", 1]]],
    ]);
  });

  it("reads records back as they were written — the edit applied, the deleted row gone", () => {
    const messages = all(idb, "model-storage", "message");
    const byKey = new Map(messages.map((m) => [String(m.key), m.read()]));
    expect(messages).toHaveLength(41);
    expect([...byKey.values()].filter((v) => v.error)).toEqual([]);
    expect(byKey.get("false_447911123456@c.us_PLAIN1")!.value).toMatchObject({ body: "PLAINTEXT-BODY-EDITED", t: 1795009999, rowId: 999 });
    // Row 1 was deleted after being written.
    expect([...byKey.keys()].some((k) => k.endsWith("3EB0000001"))).toBe(false);
    expect(byKey.get("true_33612345678@c.us_3EB0000000")!.value).toMatchObject({
      id: "true_33612345678@c.us_3EB0000000",
      t: 1795000000,
      from: "447000000000@c.us",
      to: "33612345678@c.us",
      type: "chat",
      ack: 3,
      isNewMsg: false,
      rowId: 0,
    });
  });

  it("reads a value the browser compressed, and every JavaScript type a record can hold", () => {
    const big = all(idb, "model-storage", "message").find((m) => String(m.key).endsWith("_BIG"))!.read().value!;
    expect(big.body).toBe("B".repeat(300_000));
    const contact = all(idb, "model-storage", "contact")[0].read().value!;
    expect(contact.date).toEqual(new Date(1795000000000));
    expect(contact.tags).toEqual(new Set(["a"]));
    expect(contact.meta).toEqual(new Map([["k", 1]]));
    expect(contact.big).toBe(BigInt("12345678901234567890"));
    expect(contact).toMatchObject({ nothing: null, flag: true, pi: 3.14, phoneNumber: "447911123456@c.us" });
  });

  it("reads the format the browser writes, which is newer than this Node's own", () => {
    const versions = new Set(all(idb, "model-storage", "message").map((m) => m.read().wireVersion));
    expect([...versions]).toEqual([16]);
  });

  it("finds the WebCrypto keys, key material included, though the page could not export them", () => {
    const keys = all(idb, "wawc_db_enc", "keys").map((k) => k.read().value!.key as { algorithm: string; bits?: number; extractable: boolean; keyBytes: Buffer });
    expect(keys.map((k) => [k.algorithm, k.bits, k.extractable, k.keyBytes.length])).toEqual([
      ["AES-CBC", 128, false, 16],
      ["AES-GCM", 256, false, 32],
      ["HKDF", undefined, false, 32],
    ]);
    expect(keys[1].keyBytes.equals(Buffer.alloc(32, 7))).toBe(true);
    expect(keys[2].keyBytes.equals(Buffer.alloc(32, 9))).toBe(true);
  });

  it("and with the key from disk, the encrypted message text opens", () => {
    const key = (all(idb, "wawc_db_enc", "keys")[0].read().value!.key as { keyBytes: Buffer }).keyBytes;
    let opened = 0;
    for (const m of all(idb, "model-storage", "message")) {
      const envelope = m.read().value!.msgRowOpaqueData as { iv: Uint8Array; _data: Uint8Array; _keyId: number } | undefined;
      if (!envelope) continue;
      const decipher = crypto.createDecipheriv("aes-128-cbc", key, envelope.iv);
      const text = Buffer.concat([decipher.update(envelope._data), decipher.final()]).toString("utf8");
      expect(text).toMatch(/^SECRET-BODY-\d+ hello there$/);
      opened += 1;
    }
    expect(opened).toBe(34);
  });

  it("never needs the database's lock or writes anything beside it", () => {
    const before = fs.readdirSync(FIXTURE).sort();
    openIndexedDb(FIXTURE);
    expect(fs.readdirSync(FIXTURE).sort()).toEqual(before);
    expect(before).toEqual(["000003.log", "CURRENT", "MANIFEST-000001"]);
  });
});

describe("LevelDB tables, built by hand", () => {
  const varint = (n: number) => {
    const out: number[] = [];
    let v = n;
    while (v >= 128) {
      out.push((v % 128) | 128);
      v = Math.floor(v / 128);
    }
    out.push(v);
    return Buffer.from(out);
  };
  const internalKey = (user: string, seq: number, live: boolean) => {
    const trailer = Buffer.alloc(8);
    trailer.writeUIntLE(seq, 1, 6);
    trailer[0] = live ? 1 : 0;
    return Buffer.concat([Buffer.from(user, "latin1"), trailer]);
  };
  const block = (entries: [Buffer, Buffer][]) => {
    const parts: Buffer[] = [];
    for (const [key, value] of entries) parts.push(varint(0), varint(key.length), varint(value.length), key, value);
    const restarts = Buffer.alloc(8);
    restarts.writeUInt32LE(0, 0);
    restarts.writeUInt32LE(1, 4);
    return Buffer.concat([...parts, restarts]);
  };
  /** One data block, one index block, a footer — the smallest valid table. */
  function table(entries: [Buffer, Buffer][]): Buffer {
    const data = block(entries);
    const trailer = Buffer.from([0, 0, 0, 0, 0]); // no compression, checksum unread
    const handle = Buffer.concat([varint(0), varint(data.length)]);
    const index = block([[entries[entries.length - 1][0], handle]]);
    const indexOffset = data.length + 5;
    const footer = Buffer.alloc(48);
    Buffer.concat([varint(0), varint(0), varint(indexOffset), varint(index.length)]).copy(footer);
    Buffer.from("57fb808b247547db", "hex").copy(footer, 40);
    return Buffer.concat([data, trailer, index, trailer, footer]);
  }

  it("reads keys, sequence numbers, values and deletions", () => {
    const file = table([
      [internalKey("alpha", 7, true), Buffer.from("one")],
      [internalKey("beta", 9, false), Buffer.alloc(0)],
    ]);
    const entries = [...readTable(file)].map((e: { key: Buffer; seq: number; live: boolean; value: Buffer }) => [e.key.toString(), e.seq, e.live, e.value.toString()]);
    expect(entries).toEqual([["alpha", 7, true, "one"], ["beta", 9, false, ""]]);
    expect(() => [...readTable(Buffer.from("not a table at all, just some bytes that are long enough to look"))]).toThrow(/not a LevelDB table/);
  });

  it("across files the newest write wins, and a deletion removes the key", () => {
    const dir = path.join(scratch, "merge");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "000005.ldb"), table([[internalKey("a", 1, true), Buffer.from("old")], [internalKey("b", 2, true), Buffer.from("kept")], [internalKey("c", 3, true), Buffer.from("doomed")]]));
    fs.writeFileSync(path.join(dir, "000009.ldb"), table([[internalKey("a", 10, true), Buffer.from("new")], [internalKey("c", 11, false), Buffer.alloc(0)]]));
    fs.writeFileSync(path.join(dir, "000010.ldb"), Buffer.from("truncated"));
    fs.writeFileSync(path.join(dir, "LOG"), "ignored");
    const { entries, stats } = readLevelDb(dir);
    expect(entries.map((e: { key: Buffer; value: Buffer }) => [e.key.toString(), e.value.toString()]).sort()).toEqual([["a", "new"], ["b", "kept"]]);
    // A file that cannot be read is reported, never guessed at.
    expect(stats).toMatchObject({ tables: 2, logs: 0 });
    expect(stats.unreadable).toEqual(["000010.ldb: not a LevelDB table"]);
  });
});

describe("the small decoders", () => {
  it("snappy: literals, copies, and a copy that overlaps itself", () => {
    // "abcabcabcabc": literal "abc", then a 9-byte copy from 3 back.
    const copy = Buffer.from([12, (3 - 1) << 2, 0x61, 0x62, 0x63, ((9 - 1) << 2) | 2, 3, 0]);
    expect(snappyDecompress(copy).toString()).toBe("abcabcabcabc");
    const literal = Buffer.concat([Buffer.from([5, (5 - 1) << 2]), Buffer.from("hello")]);
    expect(snappyDecompress(literal).toString()).toBe("hello");
    expect(() => snappyDecompress(Buffer.from([4, ((4 - 1) << 2) | 2, 9, 0]))).toThrow(/bad copy offset/);
    expect(() => snappyDecompress(Buffer.from([9, (2 - 1) << 2, 0x61, 0x62]))).toThrow(/length mismatch/);
  });

  it("varints and IndexedDB keys", () => {
    expect(readVarint(Buffer.from([0x05]), 0)).toEqual([5, 1]);
    expect(readVarint(Buffer.from([0xac, 0x02]), 0)).toEqual([300, 2]);
    expect(() => readVarint(Buffer.from([0x80]), 0)).toThrow(/past the end/);
    // type 1 = string: length in UTF-16 units, then big-endian UTF-16.
    expect(readIdbKey(Buffer.from([1, 2, 0, 0x68, 0, 0x69]), 0)).toEqual(["hi", 6]);
    const number = Buffer.alloc(9);
    number[0] = 3;
    number.writeDoubleLE(42.5, 1);
    expect(readIdbKey(number, 0)).toEqual([42.5, 9]);
    expect(readIdbKey(Buffer.from([4, 2, 1, 1, 0, 0x61, 1, 1, 0, 0x62]), 0)).toEqual([["a", "b"], 10]);
  });
});

describe("what the second probe is allowed to say", () => {
  it("describes records by field name, kind and size — never by value", () => {
    const fields = shapeOf([
      { id: "true_447911123456@c.us_3EB0", body: "a private message", msgRowOpaqueData: { iv: Buffer.alloc(16), _data: Buffer.alloc(48) }, "447911123456@c.us": 1 },
      { id: "false_447911123456@c.us_3EB1", t: 1795000000 },
    ]);
    const text = JSON.stringify([...fields.entries()].map(([name, f]) => [name, [...(f as { kinds: Map<string, number> }).kinds.entries()]]));
    expect(text).not.toMatch(/private message|447911123456/);
    expect([...fields.keys()]).toEqual(["id", "body", "msgRowOpaqueData", "msgRowOpaqueData.iv", "msgRowOpaqueData._data", "<12 digits>@c.us", "t"]);
    expect((fields.get("msgRowOpaqueData._data") as { min: number; max: number }).max).toBe(48);
  });

  it("masks digits and odd characters, names kinds, and classes addresses without repeating them", () => {
    expect(mask("447911123456@c.us")).toBe("<12 digits>@c.us");
    expect(mask("key 12")).toBe("key 12");
    expect(mask(`name${String.fromCharCode(0x202e)}x`)).toBe("name?x");
    expect(mask("x".repeat(200))).toHaveLength(60);
    expect([kindOf(null), kindOf(undefined), kindOf("a"), kindOf(1), kindOf([]), kindOf({}), kindOf(Buffer.alloc(1)), kindOf(new Map()), kindOf(new Date(0))]).toEqual([
      "null", "undefined", "string", "number", "array", "object", "bytes", "map", "date",
    ]);
    expect(["true_447911123456@c.us_A", "false_120363041234567890@g.us_B", "true_98765432101234@lid_C", "status@broadcast", "weird"].map(addressClass)).toEqual([
      "@c.us", "@g.us", "@lid", "@broadcast", "other",
    ]);
  });

  it("says what decrypted bytes look like, not what they say", () => {
    expect(plaintextKind(Buffer.from("see you Thursday"))).toBe("plain text");
    expect(plaintextKind(Buffer.from('{"a":1}'))).toBe("JSON text");
    expect(plaintextKind(Buffer.from([0x0a, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff, 0xfe]))).toBe("structured binary (protobuf-like)");
    expect(plaintextKind(Buffer.from([0xff, 0xff, 0xff]))).toBe("binary");
    expect(plaintextKind(Buffer.alloc(0))).toBe("empty");
  });
});
