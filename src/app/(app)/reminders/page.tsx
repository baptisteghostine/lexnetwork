import { ReminderForm } from "@/components/reminder-form";
import { RemindersList } from "@/components/reminders-list";
import { requireAuth } from "@/lib/auth";
import { now as currentTime } from "@/lib/time";
import { listReminders } from "@/server/reminders";

export const dynamic = "force-dynamic";

export default async function RemindersPage() {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const now = currentTime();
  const { due, upcoming, recurring } = await listReminders(now);

  return (
    <div>
      <header className="flex items-center gap-3 border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">Reminders</h1>
        <span className="text-xs text-muted-foreground">
          {due.length} due · {upcoming.length} upcoming
        </span>
      </header>
      <div className="max-w-3xl space-y-6 px-5 py-4">
        <ReminderForm />
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Due
          </h2>
          <RemindersList rows={due} now={now} kind="due" />
        </section>
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Upcoming
          </h2>
          <RemindersList rows={upcoming} now={now} kind="upcoming" />
        </section>
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recurring rules
          </h2>
          <RemindersList rows={recurring} now={now} kind="recurring" />
        </section>
      </div>
    </div>
  );
}
