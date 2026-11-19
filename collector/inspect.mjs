#!/usr/bin/env node
// Rolo — WhatsApp Desktop feasibility probe, part 2 (SPEC §15).
//
// Part 1 showed where WhatsApp Desktop keeps its messages (the browser
// store under EBWebView\...\IndexedDB) and that those files can be read
// while it runs. This part answers the remaining question: is the text of
// a message readable from those files, or locked away?
//
// To answer it the script has to look inside the store, which part 1
// never did. So, plainly:
//   - it reads WhatsApp's store files as bytes (never opening the
//     database, never writing or locking anything in WhatsApp's folder);
//   - it decodes records IN MEMORY to learn their shape, and if message
//     text is encrypted it tries the keys found in the same store on a
//     few messages, again in memory, to see whether they fit;
//   - the report holds only names of tables and fields, counts, sizes and
//     yes/no answers. No message text, no contact name, no phone number
//     is printed, written to disk or sent anywhere. There is no network
//     code in this file or in idb.mjs.
// Read the report before you send it back.
//
// Run:   node inspect.mjs
// (idb.mjs must sit in the same folder.)

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HostObject, openIndexedDb } from "./idb.mjs";

const REPORT = path.resolve("rolo-whatsapp-inspect-report.txt");
const SAMPLE = 600; // records looked at per table
const TRIALS = 40; // encrypted messages tried per key
const lines = [];
const say = (text = "") => {
  lines.push(text);
  console.log(text);
};

/** Names of fields can themselves be data (an object keyed by phone number). */
export function mask(text) {
  return String(text)
    .replace(/\d{5,}/g, (run) => `<${run.length} digits>`)
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 60);
}

export function kindOf(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof HostObject) return value.kind === "CryptoKey" ? `key(${value.algorithm})` : value.kind;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return "bytes";
  if (Array.isArray(value)) return "array";
  if (value instanceof Map) return "map";
  if (value instanceof Set) return "set";
  if (value instanceof Date) return "date";
  return typeof value === "object" ? "object" : typeof value;
}

/** What kind of WhatsApp address an id is — the class only, never the id. */
export function addressClass(id) {
  const text = String(id);
  for (const suffix of ["@c.us", "@s.whatsapp.net", "@lid", "@g.us", "@newsletter", "@broadcast", "@call"]) {
    if (text.includes(suffix)) return suffix;
  }
  return "other";
}

function bump(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function listCounts(map, limit = 12) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, n]) => `${k} ${n}`).join(", ") || "—";
}

/** Field names, kinds and sizes of a table's records. Never a value. */
export function shapeOf(records) {
  const fields = new Map();
  const note = (name, value) => {
    const key = mask(name);
    const f = fields.get(key) ?? { n: 0, kinds: new Map(), min: Infinity, max: 0 };
    f.n += 1;
    const kind = kindOf(value);
    bump(f.kinds, kind);
    const size = kind === "string" || kind === "bytes" || kind === "array" ? value.length : null;
    if (size !== null) {
      f.min = Math.min(f.min, size);
      f.max = Math.max(f.max, size);
    }
    fields.set(key, f);
  };
  for (const record of records) {
    if (kindOf(record) !== "object") {
      note("(value)", record);
      continue;
    }
    for (const [name, value] of Object.entries(record)) {
      note(name, value);
      // One level down, for the envelopes that matter (an encrypted body is an object).
      if (kindOf(value) === "object") for (const [inner, v] of Object.entries(value)) note(`${name}.${inner}`, v);
    }
  }
  return fields;
}

function printShape(fields, total) {
  const rows = [...fields.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [name, f] of rows.slice(0, 70)) {
    const size = f.max > 0 ? `, length ${f.min}–${f.max}` : "";
    say(`      ${name}: ${listCounts(f.kinds, 4)} (in ${f.n} of ${total}${size})`);
  }
  if (rows.length > 70) say(`      … ${rows.length - 70} more field names`);
}

/** Every WebCrypto key in the store, with where it sits. */
function findKeys(idb) {
  const found = [];
  for (const db of idb.databases) {
    for (const store of db.stores.values()) {
      let looked = 0;
      for (const record of idb.records(db.name, store.name)) {
        if (looked++ > 5000) break;
        const read = record.read();
        if (!read.value || kindOf(read.value) !== "object") continue;
        const visit = (value, where, depth) => {
          if (value instanceof HostObject && value.kind === "CryptoKey") {
            found.push({ db: db.name, store: store.name, field: where, recordKey: record.key, key: value, record: read.value });
          } else if (depth < 3 && kindOf(value) === "object") {
            for (const [name, v] of Object.entries(value)) visit(v, where ? `${where}.${name}` : name, depth + 1);
          }
        };
        visit(read.value, "", 0);
      }
    }
  }
  return found;
}

/** What decrypted bytes look like, without saying what they are. */
export function plaintextKind(bytes) {
  if (bytes.length === 0) return "empty";
  const text = bytes.toString("utf8");
  if (!text.includes("�") && /^[\x09\x0a\x0d\x20-퟿-￼]*$/.test(text)) {
    try {
      JSON.parse(text);
      return "JSON text";
    } catch {
      return "plain text";
    }
  }
  // Protocol Buffers start with a field tag: a small number with a wire type 0–5.
  const wire = bytes[0] & 7;
  return wire <= 5 && bytes[0] >> 3 > 0 ? "structured binary (protobuf-like)" : "binary";
}

function tryDecrypt(key, envelope) {
  const iv = envelope.iv ?? envelope._iv;
  const data = envelope._data ?? envelope.data ?? envelope.ciphertext;
  if (!iv || !data || !key.keyBytes) return null;
  const algorithm = key.algorithm === "AES-CBC" ? `aes-${key.bits}-cbc` : key.algorithm === "AES-GCM" ? `aes-${key.bits}-gcm` : null;
  if (!algorithm) return null;
  try {
    const decipher = crypto.createDecipheriv(algorithm, key.keyBytes, Buffer.from(iv));
    let body = Buffer.from(data);
    if (algorithm.endsWith("gcm")) {
      decipher.setAuthTag(body.subarray(body.length - 16));
      body = body.subarray(0, body.length - 16);
    }
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }
}

function findStore() {
  const flag = process.argv.indexOf("--dir");
  if (flag > 0 && process.argv[flag + 1]) return path.resolve(process.argv[flag + 1]);
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const packages = path.join(local, "Packages");
  let names = [];
  try {
    names = fs.readdirSync(packages).filter((n) => /whatsapp/i.test(n));
  } catch {
    return null;
  }
  for (const name of names) {
    const base = path.join(packages, name, "LocalCache", "EBWebView", "Default", "IndexedDB");
    try {
      const store = fs.readdirSync(base).find((n) => /whatsapp.*\.indexeddb\.leveldb$/i.test(n));
      if (store) return path.join(base, store);
    } catch {
      // not this package
    }
  }
  return null;
}

function inspect(dir) {
  const started = Date.now();
  const idb = openIndexedDb(dir);
  say(`  read ${idb.stats.tables} table files and ${idb.stats.logs} log files (${idb.stats.entries} entries) in ${Date.now() - started} ms`);
  if (idb.stats.unreadable.length) say(`  could not read: ${idb.stats.unreadable.slice(0, 8).map(mask).join("; ")}`);

  say("");
  say("== Databases and tables (record counts) ==");
  for (const db of idb.databases) {
    say(`  ${mask(db.name)}`);
    for (const store of [...db.stores.values()].sort((a, b) => b.records.length - a.records.length).slice(0, 80)) {
      say(`    ${mask(store.name ?? "(unnamed)")}  ${store.records.length}`);
    }
  }

  // The tables a collector would need: messages, chats, contacts.
  const interesting = [];
  for (const db of idb.databases) {
    for (const store of db.stores.values()) {
      if (/^(message|chat|contact|lid|participant|msg)/i.test(store.name ?? "") || /lid|pn-map|jid/i.test(store.name ?? "")) {
        interesting.push([db.name, store.name, store.records.length]);
      }
    }
  }

  say("");
  say("== Shape of the tables that matter (field names and kinds only) ==");
  const messages = { total: 0, decoded: 0, errors: new Map(), classes: new Map(), fromMe: new Map(), plain: 0, opaque: 0, neither: 0, envelopes: [], keyIds: new Map(), types: new Map(), oldest: Infinity, newest: 0, wire: new Map() };
  for (const [dbName, storeName, count] of interesting) {
    const sample = [];
    let errors = 0;
    let external = 0;
    let n = 0;
    const isMessages = storeName === "message";
    for (const record of idb.records(dbName, storeName)) {
      n += 1;
      if (isMessages) {
        messages.total += 1;
        const key = String(record.key);
        bump(messages.classes, addressClass(key));
        bump(messages.fromMe, key.startsWith("true_") ? "sent" : key.startsWith("false_") ? "received" : "other");
      }
      if (n > SAMPLE && !isMessages) continue;
      if (isMessages && n > 20000) continue;
      const read = record.read();
      if (read.error) {
        errors += 1;
        if (isMessages) bump(messages.errors, mask(read.error));
        continue;
      }
      if (read.external) {
        external += 1;
        continue;
      }
      if (read.wireVersion) bump(messages.wire, `v${read.wireVersion}`);
      if (n <= SAMPLE) sample.push(read.value);
      if (!isMessages || kindOf(read.value) !== "object") continue;
      const m = read.value;
      messages.decoded += 1;
      bump(messages.types, mask(m.type ?? "(none)"));
      if (typeof m.t === "number") {
        messages.oldest = Math.min(messages.oldest, m.t);
        messages.newest = Math.max(messages.newest, m.t);
      }
      const envelope = m.msgRowOpaqueData;
      if (typeof m.body === "string" && m.body.length > 0) messages.plain += 1;
      else if (kindOf(envelope) === "object") {
        messages.opaque += 1;
        bump(messages.keyIds, `key ${mask(envelope._keyId ?? "?")}`);
        if (messages.envelopes.length < 400) messages.envelopes.push(envelope);
      } else messages.neither += 1;
    }
    say(`  ${mask(dbName)} / ${mask(storeName)} — ${count} records, ${sample.length} looked at${errors ? `, ${errors} could not be decoded` : ""}${external ? `, ${external} kept in separate files` : ""}`);
    printShape(shapeOf(sample), sample.length);
  }

  say("");
  say("== Messages ==");
  if (messages.total === 0) {
    say("  No table called \"message\" was found. The tables above show what there is instead.");
  } else {
    say(`  ${messages.total} messages; ${messages.decoded} decoded`);
    if (messages.errors.size) say(`  decoding problems: ${listCounts(messages.errors, 5)}`);
    say(`  by chat kind: ${listCounts(messages.classes)}`);
    say(`  by direction: ${listCounts(messages.fromMe)}`);
    say(`  by type: ${listCounts(messages.types, 10)}`);
    if (messages.newest > 0) {
      const month = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 7);
      say(`  dated from ${month(messages.oldest)} to ${month(messages.newest)}`);
    }
    say(`  text readable as it is: ${messages.plain}`);
    say(`  text inside an encrypted envelope: ${messages.opaque}${messages.opaque ? ` (${listCounts(messages.keyIds, 6)})` : ""}`);
    say(`  no text field (media, system messages, or a layout this probe does not know): ${messages.neither}`);
  }

  say("");
  say("== Keys stored alongside (never the key itself) ==");
  const keys = findKeys(idb);
  if (keys.length === 0) say("  No WebCrypto key objects were found in any table.");
  const byPlace = new Map();
  for (const k of keys) bump(byPlace, `${mask(k.db)} / ${mask(k.store)} . ${mask(k.field)}: ${k.key.algorithm}${k.key.bits ? ` ${k.key.bits}-bit` : ""}, ${k.key.extractable ? "exportable" : "marked non-exportable"}, key bytes on disk: ${k.key.keyBytes ? `yes (${k.key.keyBytes.length})` : "no"}`);
  for (const [place, n] of byPlace) say(`  ${n} × ${place}`);

  say("");
  say("== Can the encrypted text be opened with those keys? ==");
  if (messages.opaque === 0) {
    say(messages.plain > 0 ? "  Not needed: message text is stored readable." : "  Nothing to try: no encrypted envelopes were seen.");
  } else if (keys.length === 0) {
    say("  No. The envelopes are there but no key is stored in this store.");
  } else {
    const trial = messages.envelopes.slice(0, TRIALS);
    let best = { opened: 0 };
    for (const k of keys) {
      const kinds = new Map();
      let opened = 0;
      let matchedId = 0;
      for (const envelope of trial) {
        const plain = tryDecrypt(k.key, envelope);
        if (!plain) continue;
        opened += 1;
        bump(kinds, plaintextKind(plain));
        const id = k.record?.id ?? k.recordKey;
        if (String(id) === String(envelope._keyId)) matchedId += 1;
      }
      if (opened > best.opened) best = { opened, kinds, matchedId, k };
    }
    if (best.opened === 0) {
      say(`  No: none of the ${keys.length} stored keys opened any of ${trial.length} envelopes tried.`);
      say("  The text key is probably derived from something not kept in this store.");
    } else {
      say(`  YES: a stored key opened ${best.opened} of ${trial.length} envelopes tried.`);
      say(`  the key that worked: ${mask(best.k.db)} / ${mask(best.k.store)} . ${mask(best.k.field)} (${best.k.key.algorithm})`);
      say(`  its record id matched the envelope's key id in ${best.matchedId} of ${best.opened}`);
      say(`  what came out looks like: ${listCounts(best.kinds)}`);
    }
  }
  say("");
  say(`  value format versions seen: ${listCounts(messages.wire)}`);
}

function main() {
  say("Rolo — WhatsApp Desktop feasibility probe, part 2");
  say(`  run at ${new Date().toISOString()} · Node ${process.version} · ${os.type()} ${os.release()}`);
  const dir = findStore();
  if (!dir) {
    say("  WhatsApp Desktop's message store was not found. Is WhatsApp installed from the Microsoft Store and linked?");
  } else {
    say(`  store: …\\${path.basename(dir)}`);
    try {
      inspect(dir);
    } catch (err) {
      say(`  The store could not be read: ${mask(err?.message ?? err)}`);
    }
  }
  say("");
  say("No message text, contact name or phone number is in this report.");
  fs.writeFileSync(REPORT, `${lines.join("\n")}\n`, "utf8");
  console.log(`\nSaved to ${REPORT}\nRead it if you like, then send that file back.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
