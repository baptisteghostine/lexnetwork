// Rolo collector — a read-only reader for Chromium's IndexedDB files
// (SPEC §15). WhatsApp Desktop is a WebView2 wrapper around WhatsApp Web,
// which keeps its data in IndexedDB; on disk that is a LevelDB directory.
//
// This reads those files as files. It never opens the database the way a
// database library would — doing so takes a lock, replays the log and
// rewrites the manifest, all of which would be writing into WhatsApp's
// folder while WhatsApp is running. Everything here is fs.readFileSync on
// bytes, and nothing is ever written back.
//
// No dependencies: LevelDB tables and logs, Snappy, IndexedDB's key
// layout, Blink's value envelope and V8's value format are all decoded
// here.

import fs from "node:fs";
import path from "node:path";

// ---------- small readers ----------

/** LEB128 unsigned varint. Returns [value, nextOffset]; value is a Number (safe to 2^53). */
export function readVarint(buf, at) {
  let result = 0;
  let shift = 1;
  let i = at;
  for (;;) {
    if (i >= buf.length) throw new Error("varint runs past the end");
    const byte = buf[i++];
    result += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) break;
    shift *= 128;
    if (shift > 2 ** 56) throw new Error("varint too long");
  }
  return [result, i];
}

/** Little-endian integer of `size` bytes (IndexedDB's EncodeInt). */
function readIntLE(buf, at, size) {
  let value = 0;
  for (let i = size - 1; i >= 0; i--) value = value * 256 + buf[at + i];
  return value;
}

// ---------- Snappy ----------

export function snappyDecompress(src) {
  let [length, i] = readVarint(src, 0);
  const out = Buffer.allocUnsafe(length);
  let o = 0;
  while (i < src.length) {
    const tag = src[i++];
    const kind = tag & 3;
    if (kind === 0) {
      let len = tag >> 2;
      if (len >= 60) {
        const extra = len - 59;
        len = readIntLE(src, i, extra);
        i += extra;
      }
      len += 1;
      src.copy(out, o, i, i + len);
      i += len;
      o += len;
      continue;
    }
    let len;
    let offset;
    if (kind === 1) {
      len = ((tag >> 2) & 7) + 4;
      offset = ((tag >> 5) << 8) | src[i++];
    } else if (kind === 2) {
      len = (tag >> 2) + 1;
      offset = src[i] | (src[i + 1] << 8);
      i += 2;
    } else {
      len = (tag >> 2) + 1;
      offset = readIntLE(src, i, 4);
      i += 4;
    }
    if (offset === 0 || offset > o) throw new Error("snappy: bad copy offset");
    // Overlapping copies are legal and mean "repeat": copy byte by byte.
    for (let k = 0; k < len; k++) out[o + k] = out[o - offset + k];
    o += len;
  }
  if (o !== length) throw new Error("snappy: length mismatch");
  return out;
}

// ---------- LevelDB ----------

const TABLE_MAGIC = Buffer.from("57fb808b247547db", "hex");

/** Entries of one block: [key, value] pairs with prefix-compressed keys. */
function* blockEntries(block) {
  if (block.length < 4) return;
  const restarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - restarts * 4;
  let at = 0;
  let key = Buffer.alloc(0);
  while (at < end) {
    let shared, unshared, valueLen;
    [shared, at] = readVarint(block, at);
    [unshared, at] = readVarint(block, at);
    [valueLen, at] = readVarint(block, at);
    key = Buffer.concat([key.subarray(0, shared), block.subarray(at, at + unshared)]);
    at += unshared;
    const value = block.subarray(at, at + valueLen);
    at += valueLen;
    yield [key, value];
  }
}

function readBlock(file, offset, size) {
  const raw = file.subarray(offset, offset + size);
  const compression = file[offset + size];
  if (compression === 0) return raw;
  if (compression === 1) return snappyDecompress(raw);
  throw new Error(`table block uses compression ${compression}, which this reader does not know`);
}

/** Every entry of an .ldb table: { key, seq, live, value }. */
export function* readTable(file) {
  if (file.length < 48 || !file.subarray(file.length - 8).equals(TABLE_MAGIC)) {
    throw new Error("not a LevelDB table");
  }
  let at = file.length - 48;
  // footer: metaindex handle, then index handle
  [, at] = readVarint(file, at);
  [, at] = readVarint(file, at);
  let indexOffset, indexSize;
  [indexOffset, at] = readVarint(file, at);
  [indexSize] = readVarint(file, at);
  for (const [, handle] of blockEntries(readBlock(file, indexOffset, indexSize))) {
    const [offset, next] = readVarint(handle, 0);
    const [size] = readVarint(handle, next);
    for (const [internalKey, value] of blockEntries(readBlock(file, offset, size))) {
      if (internalKey.length < 8) continue;
      const trailer = internalKey.subarray(internalKey.length - 8);
      const type = trailer[0];
      const seq = readIntLE(trailer, 1, 7);
      yield { key: internalKey.subarray(0, internalKey.length - 8), seq, live: type === 1, value };
    }
  }
}

/** Every operation in a .log file (the not-yet-compacted writes). */
export function* readLog(file) {
  const BLOCK = 32768;
  let pending = [];
  const records = [];
  for (let blockStart = 0; blockStart < file.length; blockStart += BLOCK) {
    let at = blockStart;
    const blockEnd = Math.min(blockStart + BLOCK, file.length);
    while (at + 7 <= blockEnd) {
      const length = file.readUInt16LE(at + 4);
      const type = file[at + 6];
      if (type === 0 && length === 0) break; // zero padding to the end of the block
      const data = file.subarray(at + 7, Math.min(at + 7 + length, blockEnd));
      at += 7 + length;
      if (type === 1) {
        records.push(data);
        pending = [];
      } else if (type === 2) {
        pending = [data];
      } else if (type === 3) {
        if (pending.length) pending.push(data);
      } else if (type === 4) {
        if (pending.length) {
          pending.push(data);
          records.push(Buffer.concat(pending));
        }
        pending = [];
      }
    }
  }
  for (const batch of records) {
    if (batch.length < 12) continue;
    let seq = readIntLE(batch, 0, 7); // sequence numbers fit 56 bits
    const count = batch.readUInt32LE(8);
    let at = 12;
    try {
      for (let n = 0; n < count; n++) {
        const type = batch[at++];
        let keyLen;
        [keyLen, at] = readVarint(batch, at);
        const key = batch.subarray(at, at + keyLen);
        at += keyLen;
        let value = Buffer.alloc(0);
        if (type === 1) {
          let valueLen;
          [valueLen, at] = readVarint(batch, at);
          value = batch.subarray(at, at + valueLen);
          at += valueLen;
        }
        yield { key, seq, live: type === 1, value };
        seq += 1;
      }
    } catch {
      // A torn final batch (the app was mid-write): keep what was whole.
    }
  }
}

/**
 * The current contents of a LevelDB directory: for each key, the newest
 * write, with deletions applied. Files are read as plain bytes.
 */
export function readLevelDb(dir) {
  const newest = new Map();
  const stats = { tables: 0, logs: 0, entries: 0, unreadable: [] };
  for (const name of fs.readdirSync(dir).sort()) {
    const isTable = /\.(ldb|sst)$/i.test(name);
    const isLog = /\.log$/i.test(name);
    if (!isTable && !isLog) continue;
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(dir, name));
    } catch (err) {
      stats.unreadable.push(`${name}: ${err.code ?? "unreadable"}`);
      continue;
    }
    try {
      for (const entry of isTable ? readTable(bytes) : readLog(bytes)) {
        stats.entries += 1;
        const id = entry.key.toString("latin1");
        const have = newest.get(id);
        if (!have || entry.seq >= have.seq) newest.set(id, entry);
      }
      if (isTable) stats.tables += 1;
      else stats.logs += 1;
    } catch (err) {
      stats.unreadable.push(`${name}: ${String(err.message).slice(0, 80)}`);
    }
  }
  const live = [];
  for (const entry of newest.values()) if (entry.live) live.push(entry);
  return { entries: live, stats };
}

// ---------- IndexedDB on LevelDB ----------

function readPrefix(key) {
  const first = key[0];
  const dbBytes = ((first >> 5) & 7) + 1;
  const storeBytes = ((first >> 2) & 7) + 1;
  const indexBytes = (first & 3) + 1;
  let at = 1;
  const databaseId = readIntLE(key, at, dbBytes);
  at += dbBytes;
  const objectStoreId = readIntLE(key, at, storeBytes);
  at += storeBytes;
  const indexId = readIntLE(key, at, indexBytes);
  at += indexBytes;
  return { databaseId, objectStoreId, indexId, at };
}

function readUtf16BE(buf, at, units) {
  const copy = Buffer.from(buf.subarray(at, at + units * 2));
  copy.swap16();
  return copy.toString("utf16le");
}

function readStringWithLength(buf, at) {
  const [units, next] = readVarint(buf, at);
  return [readUtf16BE(buf, next, units), next + units * 2];
}

/** An IndexedDB key: string, number, date, binary or an array of them. */
export function readIdbKey(buf, at) {
  const type = buf[at++];
  if (type === 0) return [null, at];
  if (type === 1) return readStringWithLength(buf, at);
  if (type === 2) return [new Date(buf.readDoubleLE(at)), at + 8];
  if (type === 3) return [buf.readDoubleLE(at), at + 8];
  if (type === 4) {
    let count;
    [count, at] = readVarint(buf, at);
    const items = [];
    for (let i = 0; i < count; i++) {
      let item;
      [item, at] = readIdbKey(buf, at);
      items.push(item);
    }
    return [items, at];
  }
  if (type === 6) {
    const [len, next] = readVarint(buf, at);
    return [buf.subarray(next, next + len), next + len];
  }
  return [undefined, at];
}

/** A value an IndexedDB record could not carry inline or that only a browser can hold. */
export class HostObject {
  constructor(kind, detail = {}) {
    this.kind = kind;
    Object.assign(this, detail);
  }
}

const AES = { 1: "AES-CBC", 9: "AES-GCM", 11: "AES-CTR", 12: "AES-KW" };
const NO_PARAMS = { 16: "HKDF", 17: "PBKDF2" };

const VIEW = {
  b: Int8Array, B: Uint8Array, C: Uint8ClampedArray, w: Int16Array, W: Uint16Array,
  d: Int32Array, D: Uint32Array, f: Float32Array, F: Float64Array, q: BigInt64Array, Q: BigUint64Array,
};

/**
 * V8's value serialization, read here rather than with Node's own
 * v8.deserialize: Node refuses a wire format newer than the V8 it was
 * built with, and the browser inside WhatsApp Desktop is usually newer
 * than the Node on a laptop. Only reading is implemented.
 */
class ValueReader {
  constructor(buf) {
    this.buf = buf;
    this.at = 0;
    this.objects = [];
  }

  byte() {
    if (this.at >= this.buf.length) throw new Error("value ends early");
    return this.buf[this.at++];
  }

  varint() {
    const [value, next] = readVarint(this.buf, this.at);
    this.at = next;
    return value;
  }

  bytes(length) {
    if (this.at + length > this.buf.length) throw new Error("value ends early");
    const out = this.buf.subarray(this.at, this.at + length);
    this.at += length;
    return out;
  }

  double() {
    const value = this.buf.readDoubleLE(this.at);
    this.at += 8;
    return value;
  }

  tag() {
    let t = this.byte();
    while (t === 0) t = this.byte(); // padding before a two-byte string
    return String.fromCharCode(t);
  }

  peekTag() {
    let at = this.at;
    while (at < this.buf.length && this.buf[at] === 0) at++;
    return at < this.buf.length ? String.fromCharCode(this.buf[at]) : "";
  }

  keep(object) {
    this.objects.push(object);
    return object;
  }

  string(tag) {
    const length = this.varint();
    const raw = this.bytes(length);
    if (tag === '"') return raw.toString("latin1");
    if (tag === "c") return raw.toString("utf16le");
    return raw.toString("utf8");
  }

  bigint() {
    const bitfield = this.varint();
    const negative = (bitfield & 1) === 1;
    const raw = this.bytes(Math.floor(bitfield / 2));
    let value = 0n;
    for (let i = raw.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(raw[i]);
    return negative ? -value : value;
  }

  read() {
    const tag = this.tag();
    switch (tag) {
      case "_": return undefined;
      case "-": return undefined; // a hole in an array
      case "0": return null;
      case "T": return true;
      case "F": return false;
      case "I": { const n = this.varint(); return n % 2 === 0 ? n / 2 : -(n + 1) / 2; }
      case "U": return this.varint();
      case "N": return this.double();
      case "Z": return this.bigint();
      case '"': case "c": case "S": return this.string(tag);
      case "^": return this.objects[this.varint()];
      case "o": {
        const object = this.keep({});
        while (this.peekTag() !== "{") {
          const key = this.read();
          object[String(key)] = this.read();
        }
        this.tag();
        this.varint();
        return object;
      }
      case "A": {
        const length = this.varint();
        const array = this.keep(new Array(length));
        for (let i = 0; i < length; i++) array[i] = this.read();
        while (this.peekTag() !== "$") {
          const key = this.read();
          array[String(key)] = this.read();
        }
        this.tag();
        this.varint();
        this.varint();
        return array;
      }
      case "a": {
        this.varint();
        const array = this.keep([]);
        while (this.peekTag() !== "@") {
          const key = this.read();
          array[String(key)] = this.read();
        }
        this.tag();
        this.varint();
        this.varint();
        return array;
      }
      case "D": return this.keep(new Date(this.double()));
      case "y": return this.keep(true);
      case "x": return this.keep(false);
      case "n": return this.keep(this.double());
      case "z": return this.keep(this.bigint());
      case "s": return this.keep(this.string(this.tag()));
      case "R": { const source = this.string(this.tag()); this.varint(); return this.keep(`/${source}/`); }
      case ";": {
        const map = this.keep(new Map());
        while (this.peekTag() !== ":") {
          const key = this.read();
          map.set(key, this.read());
        }
        this.tag();
        this.varint();
        return map;
      }
      case "'": {
        const set = this.keep(new Set());
        while (this.peekTag() !== ",") set.add(this.read());
        this.tag();
        this.varint();
        return set;
      }
      case "B": case "~": {
        const length = this.varint();
        if (tag === "~") this.varint();
        const buffer = this.keep(Buffer.from(this.bytes(length)));
        if (this.peekTag() !== "V") return buffer;
        this.tag();
        const kind = String.fromCharCode(this.byte());
        const offset = this.varint();
        const byteLength = this.varint();
        this.varint(); // flags (wire format 14+)
        const slice = buffer.subarray(offset, offset + byteLength);
        const Type = VIEW[kind];
        // Uint8Array is by far the common case; others are returned as their bytes.
        return this.keep(Type === Uint8Array || !Type ? slice : new Type(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)));
      }
      case "\\": return this.keep(this.host());
      default:
        throw new Error(`value uses a tag this reader does not know (${JSON.stringify(tag)})`);
    }
  }

  host() {
    const tag = String.fromCharCode(this.byte());
    if (tag !== "K") throw new Error(`value holds a browser object this reader does not know (${JSON.stringify(tag)})`);
    // A WebCrypto key. Chromium writes the raw key material even for a
    // key the page itself is not allowed to export.
    const family = this.byte();
    const detail = { family };
    if (family === 1) {
      const id = this.varint();
      detail.algorithm = AES[id] ?? `aes#${id}`;
      detail.bits = this.varint() * 8;
    } else if (family === 2) {
      detail.algorithm = "HMAC";
      detail.bits = this.varint() * 8;
      detail.hash = this.varint();
    } else if (family === 6) {
      const id = this.varint();
      detail.algorithm = NO_PARAMS[id] ?? `noparams#${id}`;
    } else {
      throw new Error(`a key of a kind this reader does not parse (family ${family})`);
    }
    const usages = this.varint();
    detail.extractable = (usages & 1) === 1;
    detail.keyBytes = Buffer.from(this.bytes(this.varint()));
    return new HostObject("CryptoKey", detail);
  }
}

/**
 * Decode one stored value. Returns { value } or { external } when the
 * value sits in a separate blob file, or { error }.
 */
export function readIdbValue(raw) {
  try {
    let [, at] = readVarint(raw, 0); // record version
    let body = raw.subarray(at);
    // IndexedDB's own wrapper: 0xFF 0x11 then 1 = "in a blob file", 2 = Snappy.
    if (body.length >= 3 && body[0] === 0xff && body[1] === 0x11) {
      if (body[2] === 1) return { external: true };
      if (body[2] === 2) body = snappyDecompress(body.subarray(3));
      else return { error: `unknown value wrapper ${body[2]}` };
    }
    // Blink's envelope: 0xFF <version> [0xFE + 12 bytes of trailer info], then V8's own 0xFF header.
    at = 0;
    if (body[at] !== 0xff) return { error: "no value header" };
    [, at] = readVarint(body, at + 1);
    if (body[at] === 0xfe) at += 13;
    if (body[at] !== 0xff) return { error: "no V8 header" };
    const [wireVersion, start] = readVarint(body, at + 1);
    const reader = new ValueReader(body.subarray(start));
    return { value: reader.read(), wireVersion };
  } catch (err) {
    return { error: String(err.message).slice(0, 100) };
  }
}

/**
 * Open an IndexedDB LevelDB directory read-only and describe it:
 * databases, their object stores, and a way to walk a store's records.
 */
export function openIndexedDb(dir) {
  const { entries, stats } = readLevelDb(dir);
  const databases = new Map(); // id → { id, name, origin, stores: Map(id → { id, name, records: [] }) }
  const database = (id) => {
    if (!databases.has(id)) databases.set(id, { id, name: null, origin: null, stores: new Map() });
    return databases.get(id);
  };
  const store = (dbId, storeId) => {
    const db = database(dbId);
    if (!db.stores.has(storeId)) db.stores.set(storeId, { id: storeId, name: null, records: [] });
    return db.stores.get(storeId);
  };
  for (const entry of entries) {
    const key = entry.key;
    if (key.length < 4) continue;
    let prefix;
    try {
      prefix = readPrefix(key);
    } catch {
      continue;
    }
    const { databaseId, objectStoreId, indexId, at } = prefix;
    try {
      if (databaseId === 0 && objectStoreId === 0 && indexId === 0) {
        if (key[at] === 201) {
          const [origin, next] = readStringWithLength(key, at + 1);
          const [name] = readStringWithLength(key, next);
          const id = readIntLE(entry.value, 0, Math.min(entry.value.length, 6));
          const db = database(id);
          db.name = name;
          db.origin = origin;
        }
      } else if (objectStoreId === 0 && indexId === 0) {
        if (key[at] === 50) {
          const [storeId, next] = readVarint(key, at + 1);
          if (key[next] === 0) store(databaseId, storeId).name = readUtf16BE(entry.value, 0, entry.value.length >> 1);
        }
      } else if (indexId === 1) {
        store(databaseId, objectStoreId).records.push(entry);
      }
    } catch {
      // A key this reader does not understand is skipped, never guessed.
    }
  }
  return {
    stats,
    databases: [...databases.values()].filter((db) => db.name !== null),
    /** Records of one store as { key, read() } — values are decoded only when asked for. */
    *records(dbName, storeName) {
      for (const db of databases.values()) {
        if (db.name !== dbName) continue;
        for (const s of db.stores.values()) {
          if (s.name !== storeName) continue;
          for (const entry of s.records) {
            let key;
            try {
              [key] = readIdbKey(entry.key, readPrefix(entry.key).at);
            } catch {
              key = undefined;
            }
            yield { key, read: () => readIdbValue(entry.value) };
          }
        }
      }
    },
  };
}
