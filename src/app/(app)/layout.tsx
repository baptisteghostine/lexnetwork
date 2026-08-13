import { cookies } from "next/headers";
import Link from "next/link";
import { and, isNotNull, isNull, lte, sql } from "drizzle-orm";

import { CommandPalette } from "@/components/command-palette";
import { SidebarNav } from "@/components/sidebar-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { now as currentTime } from "@/lib/time";
import { logoutAction } from "@/server/auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAuth();
  const dueCount =
    db
      .select({ n: sql<number>`count(*)` })
      .from(contacts)
      .where(
        and(
          isNull(contacts.archivedAt),
          isNotNull(contacts.cadenceDays),
          isNotNull(contacts.nextTouchAt),
          lte(contacts.nextTouchAt, currentTime())
        )
      )
      .get()?.n ?? 0;
  const initialDark =
    (await cookies()).get("rolo-theme")?.value === "dark";

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-48 shrink-0 flex-col border-r border-border bg-card">
        <div className="px-4 py-3.5">
          <Link
            href="/today"
            className="text-sm font-semibold tracking-tight text-primary"
          >
            Rolo
          </Link>
        </div>
        <SidebarNav dueCount={dueCount} />
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
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
      <CommandPalette />
    </div>
  );
}
