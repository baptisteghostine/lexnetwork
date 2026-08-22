"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// App-wide navigation keys (quick-add's `q` lives in its own component;
// `?` in the shortcut overlay). `a` → Ask your network.
export function GlobalHotkeys() {
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "a") {
        e.preventDefault();
        router.push("/ai#ask");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
  return null;
}
