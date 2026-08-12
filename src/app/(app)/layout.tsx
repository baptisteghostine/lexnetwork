import Link from "next/link";
import { Tags, Users } from "lucide-react";

import { requireAuth } from "@/lib/auth";
import { logoutAction } from "@/server/auth";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAuth();
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-48 shrink-0 flex-col border-r border-border bg-card/50">
        <div className="px-4 py-3.5">
          <Link href="/contacts" className="text-sm font-semibold tracking-tight">
            Rolo
          </Link>
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          <SidebarLink href="/contacts" icon={<Users />} label="Contacts" />
          <SidebarLink href="/tags" icon={<Tags />} label="Tags" />
        </nav>
        <form action={logoutAction} className="p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground"
          >
            Log out
          </Button>
        </form>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

function SidebarLink({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
    >
      {icon}
      {label}
    </Link>
  );
}
