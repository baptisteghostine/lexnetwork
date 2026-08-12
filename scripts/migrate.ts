import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { db, DB_PATH } from "../src/db/client";

migrate(db, { migrationsFolder: "./src/db/migrations" });
console.log(`migrations applied to ${DB_PATH}`);
