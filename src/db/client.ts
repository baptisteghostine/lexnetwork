import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";

// The only place better-sqlite3 is opened (see CLAUDE.md directory conventions).

const DATA_DIR = process.env.ROLO_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "rolo.db");

export type Db = BetterSQLite3Database<typeof schema>;

function open(): { db: Db; raw: Database.Database } {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return { db: drizzle(sqlite, { schema }), raw: sqlite };
}

// Survive Next.js dev-server HMR without leaking connections.
const globalForDb = globalThis as unknown as {
  __roloDb?: { db: Db; raw: Database.Database };
};

const opened = globalForDb.__roloDb ?? open();
if (process.env.NODE_ENV !== "production") globalForDb.__roloDb = opened;

export const db: Db = opened.db;
// For compiled dynamic SQL (filter engine) — same single connection.
export const rawDb: Database.Database = opened.raw;

export { DATA_DIR, DB_PATH };
