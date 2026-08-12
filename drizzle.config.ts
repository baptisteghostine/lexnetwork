import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.ROLO_DATA_DIR
      ? `${process.env.ROLO_DATA_DIR}/rolo.db`
      : "./data/rolo.db",
  },
});
