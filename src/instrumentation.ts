// Next.js instrumentation hook — runs once per server instance, before it
// serves requests. This is where the in-process job scheduler boots so
// reminders and the digest fire without any request traffic.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("@/jobs/scheduler");
    startScheduler();
  }
}
