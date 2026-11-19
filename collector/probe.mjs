#!/usr/bin/env node
// Rolo — WhatsApp Desktop feasibility probe (SPEC §15, step 0).
//
// Answers one question: can a program on this laptop read WhatsApp
// Desktop's own files, and how soon does a new message reach them?
//
// What it does: looks at the files WhatsApp Desktop keeps under your
// Windows user profile — their names, sizes, dates, and whether each one
// is an ordinary database or an encrypted one — and, with --watch, which
// of them change when a message arrives.
//
// What it never does:
//   - read, print or store the content of any message or contact;
//   - write, move or delete anything in WhatsApp's folders;
//   - use the network (there is no network code in this file);
//   - ask for administrator rights.
// Long runs of digits in file names (they can be phone numbers) are masked
// in the report. The report is a plain text file you can read before
// sending it back.
//
// Run:   node probe.mjs            layout report
//        node probe.mjs --watch    then send a WhatsApp message when asked

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const PACKAGE_HINT = /whatsapp/i;
const KNOWN_PACKAGE = "5319275A.WhatsAppDesktop_cv1g1gvanyjgm";
const MAX_DEPTH = 9;
const MAX_LISTED = 1500;
const BIG_DIR = 60; // a folder with more files than this is summarised
const secondsArg = process.argv.indexOf("--seconds");
const WATCH_SECONDS = secondsArg > 0 ? Math.max(5, Number(process.argv[secondsArg + 1]) || 120) : 120;
const SQLITE_MAGIC = "SQLite format 3\u0000";
const REPORT = path.resolve("rolo-whatsapp-probe-report.txt");

const lines = [];
const say = (text = "") => {
  lines.push(text);
  console.log(text);
};

/** File names can carry phone numbers; the report must not. */
export function mask(text) {
  return String(text).replace(/\d{7,}/g, (run) => `<${run.length} digits>`);
}

export function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * What kind of file this is, from its first bytes — and nothing else is
 * read. "sqlite" means an ordinary, unencrypted SQLite database; "opaque"
 * means the header is not one, which for a .db file means encrypted.
 */
export function classify(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (err) {
    return { kind: "unreadable", detail: err.code ?? String(err.message).slice(0, 60) };
  }
  try {
    const head = Buffer.alloc(100);
    const read = fs.readSync(fd, head, 0, 100, 0);
    if (read >= 16 && head.subarray(0, 16).toString("latin1") === SQLITE_MAGIC) {
      const pageSize = head.readUInt16BE(16);
      return { kind: "sqlite", detail: `plain SQLite, page size ${pageSize === 1 ? 65536 : pageSize}` };
    }
    if (read >= 4 && head.readUInt32BE(0) === 0x377f0682) return { kind: "wal", detail: "SQLite write-ahead log (plain header)" };
    if (read >= 4 && head.readUInt32BE(0) === 0x377f0683) return { kind: "wal", detail: "SQLite write-ahead log (plain header)" };
    if (read === 0) return { kind: "empty", detail: "empty file" };
    // How random the first bytes look: encrypted data uses nearly every
    // byte value about equally; text and structured files do not.
    const seen = new Set(head.subarray(0, read));
    return { kind: "opaque", detail: `not a plain database (${seen.size} distinct byte values in the first ${read})` };
  } catch (err) {
    return { kind: "unreadable", detail: err.code ?? String(err.message).slice(0, 60) };
  } finally {
    fs.closeSync(fd);
  }
}

const DB_LIKE = /\.(db|sqlite|sqlite3|db-wal|db-shm|wal|shm|ldb|log)$/i;

function walk(root) {
  const files = [];
  const folders = [];
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      folders.push({ dir, error: err.code ?? "unreadable" });
      return;
    }
    const here = entries.filter((e) => e.isFile());
    folders.push({ dir, files: here.length });
    for (const entry of here) {
      const full = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(full);
        files.push({ full, size: stat.size, mtimeMs: stat.mtimeMs, crowded: here.length > BIG_DIR });
      } catch {
        files.push({ full, size: -1, mtimeMs: 0, crowded: here.length > BIG_DIR });
      }
    }
    if (depth >= MAX_DEPTH) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path.join(dir, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  return { files, folders };
}

function findPackages() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return { local: null, found: [] };
  const base = path.join(local, "Packages");
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return { local, found: [] };
  }
  return { local, found: names.filter((n) => PACKAGE_HINT.test(n)).map((n) => path.join(base, n)) };
}

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 15000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return `__failed__ ${err.code ?? ""} ${String(err.stderr ?? err.message).trim().slice(0, 200)}`;
  }
}

function windowsFacts() {
  if (process.platform !== "win32") {
    say("  (not Windows — skipping the process and registry checks)");
    return;
  }
  const tasks = run("tasklist", ["/FO", "CSV", "/NH"]);
  const running = tasks
    .split(/\r?\n/)
    .map((row) => row.split('","')[0]?.replace(/^"/, ""))
    .filter((name) => name && /whatsapp|msedgewebview2/i.test(name));
  const counts = {};
  for (const name of running) counts[name] = (counts[name] ?? 0) + 1;
  say(`  processes: ${Object.keys(counts).length ? Object.entries(counts).map(([n, c]) => `${n} x${c}`).join(", ") : "WhatsApp is not running"}`);

  // Whether the machine id WhatsApp's keys are reported to depend on can
  // be read without administrator rights. The value itself is never
  // printed or stored — only whether it is there.
  const key = "HKLM\\SYSTEM\\CurrentControlSet\\Services\\TPM\\ODUID";
  const reg = run("reg", ["query", key, "/v", "RandomSeed"]);
  if (reg.startsWith("__failed__")) {
    say(`  device id (registry): not readable without admin, or absent — ${/denied/i.test(reg) ? "access denied" : "not found"}`);
  } else {
    const match = /RandomSeed\s+(REG_\w+)\s+(\S+)/.exec(reg);
    say(`  device id (registry): present, readable without admin (${match ? `${match[1]}, ${match[2].length} characters` : "unrecognised format"}) — value not recorded`);
  }
  const store = run("powershell", ["-NoProfile", "-Command", "(Get-AppxPackage -Name *WhatsApp* | Select-Object -First 1).Version"]);
  say(`  installed version: ${store.startsWith("__failed__") ? "could not be read" : store.trim() || "not installed from the Store"}`);
}

function layout(root) {
  const { files, folders } = walk(root);
  const rel = (p) => mask(path.relative(root, p) || ".");
  const total = files.reduce((sum, f) => sum + Math.max(f.size, 0), 0);
  say(`  ${files.length} files in ${folders.length} folders, ${human(total)} in all`);

  say("");
  say("  Folders (file count):");
  for (const f of folders.filter((x) => x.error || x.files > 0).slice(0, 400)) {
    say(`    ${rel(f.dir)}  ${f.error ? `[${f.error}]` : f.files}`);
  }

  const interesting = files.filter((f) => DB_LIKE.test(f.full) || (!f.crowded && f.size > 0));
  const databases = [];
  say("");
  say("  Files (size, last changed, what the first bytes say):");
  let listed = 0;
  for (const f of interesting.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (listed >= MAX_LISTED) {
      say(`    … ${interesting.length - listed} more not listed`);
      break;
    }
    const kind = DB_LIKE.test(f.full) || f.size > 4096 ? classify(f.full) : { kind: "small", detail: "" };
    if (kind.kind === "sqlite" || /\.(db|sqlite|sqlite3)$/i.test(f.full)) databases.push({ f, kind });
    say(`    ${rel(f.full)}  ${human(Math.max(f.size, 0))}  ${new Date(f.mtimeMs).toISOString()}  ${kind.detail}`);
    listed++;
  }

  say("");
  say("  Databases:");
  if (databases.length === 0) say("    none found by name or header");
  for (const { f, kind } of databases) {
    const wal = files.find((x) => x.full === `${f.full}-wal`);
    say(`    ${rel(f.full)}: ${kind.kind === "sqlite" ? "PLAIN (readable as it is)" : kind.kind === "opaque" ? "ENCRYPTED or not SQLite" : kind.detail}${wal ? `; write-ahead log ${human(wal.size)}` : "; no write-ahead log"}`);
  }
  const level = folders.filter((x) => /leveldb$/i.test(x.dir));
  say("");
  say(`  Browser-style stores (IndexedDB / LevelDB folders): ${level.length}`);
  for (const l of level) {
    const inside = files.filter((x) => path.dirname(x.full) === l.dir);
    const newest = Math.max(0, ...inside.map((x) => x.mtimeMs));
    say(`    ${rel(l.dir)}  ${inside.length} files, ${human(inside.reduce((s, x) => s + Math.max(x.size, 0), 0))}, newest ${newest ? new Date(newest).toISOString() : "—"}`);
  }
  return files;
}

function snapshot(root) {
  const map = new Map();
  for (const f of walk(root).files) map.set(f.full, `${f.size}:${Math.round(f.mtimeMs)}`);
  return map;
}

async function watch(roots) {
  const ask = (question) =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, () => {
        rl.close();
        resolve();
      });
    });
  say("");
  say("== Watch: which files change when a message arrives ==");
  say("  Keep WhatsApp Desktop open. This looks only at file sizes and dates.");
  await ask("  1) Press Enter, THEN send one WhatsApp message from your PHONE to anyone. ");
  const first = await changesAfter(roots, "phone message");
  await ask("  2) Press Enter, THEN send one message from WhatsApp DESKTOP itself. ");
  const second = await changesAfter(roots, "desktop message");
  say("");
  say(`  Summary: phone message → ${first}; desktop message → ${second}`);
}

async function changesAfter(roots, label) {
  const before = new Map();
  for (const root of roots) for (const [k, v] of snapshot(root)) before.set(k, v);
  const started = Date.now();
  const seen = new Map();
  say(`  watching for ${WATCH_SECONDS} seconds (${label})…`);
  while (Date.now() - started < WATCH_SECONDS * 1000) {
    await new Promise((r) => setTimeout(r, 1000));
    for (const root of roots) {
      for (const [file, stamp] of snapshot(root)) {
        if (before.get(file) !== stamp && !seen.has(file)) {
          seen.set(file, Math.round((Date.now() - started) / 1000));
        }
        before.set(file, stamp);
      }
    }
  }
  if (seen.size === 0) {
    say("    nothing changed on disk in that time");
    return "no file changed";
  }
  const rows = [...seen.entries()].sort((a, b) => a[1] - b[1]);
  for (const [file, seconds] of rows.slice(0, 60)) {
    const root = roots.find((r) => file.startsWith(r)) ?? "";
    say(`    +${seconds}s  ${mask(path.relative(root, file))}`);
  }
  if (rows.length > 60) say(`    … and ${rows.length - 60} more`);
  return `first change after ${rows[0][1]}s, ${rows.length} files`;
}

async function main() {
  say("Rolo — WhatsApp Desktop feasibility probe");
  say(`  run at ${new Date().toISOString()} · Node ${process.version} · ${os.type()} ${os.release()} ${os.arch()}`);
  windowsFacts();

  const { local, found } = findPackages();
  say("");
  say("== Where WhatsApp Desktop keeps its files ==");
  if (!local) say("  LOCALAPPDATA is not set — is this Windows?");
  if (found.length === 0) {
    say("  No WhatsApp folder found under Packages. Install WhatsApp from the Microsoft Store,");
    say("  link it to your phone, let it finish loading your chats, then run this again.");
  }
  for (const root of found) {
    say("");
    say(`  Package: ${path.basename(root)}${path.basename(root) === KNOWN_PACKAGE ? "" : "  (not the name expected — noted)"}`);
    layout(root);
  }
  if (process.argv.includes("--watch") && found.length > 0) await watch(found);

  say("");
  say("No message text, contact name or phone number is in this report.");
  fs.writeFileSync(REPORT, `${lines.join("\n")}\n`, "utf8");
  console.log(`\nSaved to ${REPORT}\nRead it if you like, then send that file back.`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`The probe stopped: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
