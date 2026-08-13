"use client";

import { useState } from "react";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";

// Theme lives in a cookie the root layout reads server-side, so SSR pages
// render with the right class and never flash. The toggle flips the class
// in place for an instant switch; `initialDark` comes from the same cookie
// so server and client markup agree.
export function ThemeToggle({ initialDark }: { initialDark: boolean }) {
  const [dark, setDark] = useState(initialDark);

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    document.cookie = `rolo-theme=${next ? "dark" : "light"}; path=/; max-age=31536000; samesite=lax`;
    setDark(next);
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="size-7 p-0 text-muted-foreground"
    >
      {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
    </Button>
  );
}
