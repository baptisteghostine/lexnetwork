import { cookies } from "next/headers";
import Link from "next/link";
import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";

import { CommandPalette } from "@/components/command-palette";
import { GlobalHotkeys } from "@/components/global-hotkeys";
import { MobileShell } from "@/components/mobile-shell";
import { QuickAdd } from "@/components/quick-add";
import { ShortcutOverlay } from "@/components/shortcut-overlay";
import { SidebarNav } from "@/components/sidebar-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { contacts, duplicateCandidates, reminders, views } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { now as currentTime } from "@/lib/time";
import { logoutAction } from "@/server/auth";
import { readHealthIssues } from "@/server/health";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAuth();
  const now = currentTime();
  const dueContactCount =
    db
      .select({ n: sql<number>`count(*)` })
      .from(contacts)
      .where(
        and(
          isNull(contacts.archivedAt),
          isNotNull(contacts.cadenceDays),
          isNotNull(contacts.nextTouchAt),
          lte(contacts.nextTouchAt, now)
        )
      )
      .get()?.n ?? 0;
  const dueReminderCount =
    db
      .select({ n: sql<number>`count(*)` })
      .from(reminders)
      .where(
        and(
          isNull(reminders.rrule),
          isNull(reminders.completedAt),
          sql`COALESCE(${reminders.snoozedUntil}, ${reminders.dueAt}) <= ${now}`
        )
      )
      .get()?.n ?? 0;
  const dueCount = dueContactCount + dueReminderCount;
  const duplicateCount =
    db
      .select({ n: sql<number>`count(*)` })
      .from(duplicateCandidates)
      .where(eq(duplicateCandidates.status, "open"))
      .get()?.n ?? 0;
  const pinnedViews = db
    .select({ id: views.id, name: views.name })
    .from(views)
    .where(eq(views.pinned, true))
    .orderBy(asc(views.sortOrder), asc(views.name))
    .all();
  const initialDark =
    (await cookies()).get("rolo-theme")?.value === "dark";
  // SPEC §13: a failed backup, a dead integration, or a failing sync or
  // email job shows a banner — neither data safety nor capture is allowed
  // to fail silently (widened 2026-09-19; see lib/health.ts).
  const healthIssues = readHealthIssues();

  // One nav, two frames: the fixed desktop sidebar, and the same content
  // inside the phone drawer (SPEC §12 responsive note).
  const navContent = (
    <>
      <QuickAdd />
      <SidebarNav
        dueCount={dueCount}
        duplicateCount={duplicateCount}
        views={pinnedViews}
      />
      <div className="flex items-center justify-between gap-1 border-t border-border p-2">
        <form action={logoutAction} className="flex-1">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground"
          >
            Log out
          </Button>
        </form>
        <ThemeToggle initialDark={initialDark} />
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-48 shrink-0 flex-col border-r border-border bg-card md:flex">
        <div className="px-4 py-3.5">
          <Link
            href="/today"
            className="text-sm font-semibold tracking-tight text-primary"
          >
            Rolo
          </Link>
        </div>
        {navContent}
      </aside>
      <main className="min-w-0 flex-1">
        <MobileShell>{navContent}</MobileShell>
        {healthIssues.map((issue) => (
          <div
            key={issue.id}
            className="border-b border-red-200 bg-red-50 px-5 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          >
            {issue.message}{" "}
            <Link href={issue.href} className="underline">
              Open settings.
            </Link>
          </div>
        ))}
        {children}
      </main>
      <CommandPalette />
      <GlobalHotkeys />
      <ShortcutOverlay />
    </div>
  );
}
