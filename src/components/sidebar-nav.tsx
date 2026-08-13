"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Bell,
  Bookmark,
  Copy,
  FolderTree,
  History,
  Import,
  Settings,
  Sparkles,
  Sun,
  Tags,
  Users,
  X,
} from "lucide-react";

import { reorderViewsAction, setViewPinnedAction } from "@/server/views";

const ITEMS = [
  { href: "/today", label: "Today", icon: Sun },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/reminders", label: "Reminders", icon: Bell },
  { href: "/timeline", label: "Timeline", icon: History },
  { href: "/tags", label: "Tags", icon: Tags },
  { href: "/groups", label: "Groups", icon: FolderTree },
  { href: "/imports", label: "Imports", icon: Import },
  { href: "/duplicates", label: "Duplicates", icon: Copy },
  { href: "/ai", label: "AI", icon: Sparkles },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

type ViewLink = { id: number; name: string };

export function SidebarNav({
  dueCount,
  duplicateCount,
  views,
}: {
  dueCount: number;
  duplicateCount: number;
  views: ViewLink[];
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [dragId, setDragId] = useState<number | null>(null);
  const activeViewId = Number(search.get("view"));

  return (
    <nav className="flex-1 space-y-0.5 overflow-y-auto px-2">
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
            {(href === "/today" && dueCount > 0) ||
            (href === "/duplicates" && duplicateCount > 0) ? (
              <span
                className={`rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {href === "/today" ? dueCount : duplicateCount}
              </span>
            ) : null}
          </Link>
        );
      })}

      {/* Saved views live in the sidebar, Dex-style (above Groups' page
          link they'd sit in Dex; here below the fixed nav). */}
      {views.length > 0 && (
        <div className="pt-3">
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Views
          </p>
          {views.map((v) => {
            const active =
              pathname === "/contacts" && activeViewId === v.id;
            return (
              <Link
                key={v.id}
                href={`/contacts?view=${v.id}`}
                draggable
                onDragStart={() => setDragId(v.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId === null || dragId === v.id) return;
                  const ids = views.map((x) => x.id);
                  const from = ids.indexOf(dragId);
                  const to = ids.indexOf(v.id);
                  ids.splice(from, 1);
                  ids.splice(to, 0, dragId);
                  setDragId(null);
                  startTransition(async () => {
                    await reorderViewsAction(ids);
                    router.refresh();
                  });
                }}
                className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors [&_svg]:size-3.5 ${
                  active
                    ? "bg-accent font-medium text-primary [&_svg]:text-primary"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                }`}
              >
                <Bookmark />
                <span className="min-w-0 flex-1 truncate">{v.name}</span>
                <button
                  aria-label={`Unpin view ${v.name}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    startTransition(async () => {
                      await setViewPinnedAction(v.id, false);
                      router.refresh();
                    });
                  }}
                  className="opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </Link>
            );
          })}
        </div>
      )}
    </nav>
  );
}
