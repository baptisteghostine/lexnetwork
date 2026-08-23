"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";

// Phone-width app chrome (SPEC §12 responsive note): below md the fixed
// sidebar disappears and this takes over — a slim top bar with a menu
// button, opening the SAME nav content the desktop sidebar shows, as a
// slide-over drawer. One nav definition, two frames.

export function MobileShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // The drawer is open only for the route it was opened on — navigation
  // closes it by definition, no effect needed: tapping "Contacts" lands
  // on contacts, not on contacts behind a drawer.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;
  const setOpen = (next: boolean) => setOpenedOn(next ? pathname : null);

  // No body scroll behind an open drawer.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <div className="sticky top-0 z-40 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-2 backdrop-blur md:hidden">
        <button
          aria-label="Open menu"
          onClick={() => setOpen(true)}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Menu className="size-4.5" />
        </button>
        <Link
          href="/today"
          className="text-sm font-semibold tracking-tight text-primary"
        >
          Rolo
        </Link>
      </div>

      {open ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col overflow-y-auto border-r border-border bg-card shadow-xl">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm font-semibold tracking-tight text-primary">
                Rolo
              </span>
              <button
                aria-label="Close menu"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            {children}
          </div>
        </div>
      ) : null}
    </>
  );
}
