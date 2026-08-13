"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  FolderTree,
  Import,
  Settings,
  Sun,
  Tags,
  Users,
} from "lucide-react";

const ITEMS = [
  { href: "/today", label: "Today", icon: Sun },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/reminders", label: "Reminders", icon: Bell },
  { href: "/tags", label: "Tags", icon: Tags },
  { href: "/groups", label: "Groups", icon: FolderTree },
  { href: "/imports", label: "Imports", icon: Import },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function SidebarNav({ dueCount }: { dueCount: number }) {
  const pathname = usePathname();
  return (
    <nav className="flex-1 space-y-0.5 px-2">
      {ITEMS.map(({ href, label, icon: Icon }) => {
        const active =
          pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors [&_svg]:size-3.5 ${
              active
                ? "bg-accent font-medium text-primary [&_svg]:text-primary"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            }`}
          >
            <Icon />
            <span className="flex-1">{label}</span>
            {href === "/today" && dueCount > 0 ? (
              <span
                className={`rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {dueCount}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
