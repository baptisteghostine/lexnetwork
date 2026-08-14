// Next.js instrumentation hook — runs once per server instance, before it
// serves requests. Migrations apply here (append-only, idempotent via the
// Drizzle journal) so a fresh clone or a new Docker container comes up
// without a manual `npm run db:migrate`; then the in-process job scheduler
// boots so reminders and the digest fire without any request traffic.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const path = await import("node:path");
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    const { db } = await import("@/db/client");
    try {
      migrate(db, {
        // Relative to cwd: the repo root in dev, /app in the Docker image
        // (the Dockerfile copies the migrations to the same relative path).
        migrationsFolder: path.join(process.cwd(), "src/db/migrations"),
      });
    } catch (err) {
      // Loud, but never take the server down with a half-readable DB —
      // every page will surface the underlying error anyway.
      console.error("[rolo] migration on boot failed:", err);
    }
    const { startScheduler } = await import("@/jobs/scheduler");
    startScheduler();
  }
}
