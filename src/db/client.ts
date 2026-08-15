import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";

// The only place better-sqlite3 is opened (see CLAUDE.md directory conventions).

const DATA_DIR = process.env.ROLO_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "rolo.db");

export type Db = BetterSQLite3Database<typeof schema>;

type Opened = { db: Db; raw: Database.Database };

function open(): Opened {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const sqlite = new Database(DB_PATH);
  // Converting the journal mode needs an exclusive lock, so only ask when
  // the database isn't already in WAL — every connection after the first
  // then skips the contended operation entirely.
  if (sqlite.pragma("journal_mode", { simple: true }) !== "wal") {
    sqlite.pragma("journal_mode = WAL");
  }
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  // better-sqlite3 already defaults to 5s; set it explicitly so the value
  // is visible here rather than inherited from a library default.
  sqlite.pragma("busy_timeout = 5000");
  return { db: drizzle(sqlite, { schema }), raw: sqlite };
}

// Survive Next.js dev-server HMR without leaking connections.
const globalForDb = globalThis as unknown as { __roloDb?: Opened };

/**
 * Opened on first use, never at import time. `next build` imports every
 * route module in one worker per CPU purely to read its config; when this
 * module connected as an import side effect, that meant ~19 processes
 * racing to create and WAL-convert the same fresh database, which fails
 * the build with SQLITE_BUSY. Nothing should touch a database during a
 * build, so nothing does.
 */
function opened(): Opened {
  if (!globalForDb.__roloDb) globalForDb.__roloDb = open();
  return globalForDb.__roloDb;
}

/**
 * `db` and `rawDb` stay plain importable values for the ~50 call sites
 * that use them, but resolve to the real connection only when something
 * actually reads a property off them.
 */
function lazy<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const real = resolve();
      const value = Reflect.get(real, prop) as unknown;
      // Methods must keep their original receiver: better-sqlite3 and
      // drizzle both hold internal state on `this`.
      return typeof value === "function" ? value.bind(real) : value;
    },
    set(_target, prop, value) {
      return Reflect.set(resolve(), prop, value);
    },
    has(_target, prop) {
      return prop in resolve();
    },
    ownKeys() {
      return Reflect.ownKeys(resolve());
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(resolve());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), prop);
      // The proxy target is an empty object, so every reported property
      // has to be configurable or the invariant check throws.
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}

export const db: Db = lazy(() => opened().db);
// For compiled dynamic SQL (filter engine) — same single connection.
export const rawDb: Database.Database = lazy(() => opened().raw);

export { DATA_DIR, DB_PATH };
