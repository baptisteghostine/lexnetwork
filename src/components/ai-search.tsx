"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { nlSearchAction } from "@/server/ai";

// Natural-language search (SPEC §11): the query compiles to ordinary
// filter chips — the result lands on /contacts?f=… where the existing
// filter bar renders it, editable and saveable as a view.

export function AiSearch() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const q = query.trim();
    if (!q) return;
    start(async () => {
      const result = await nlSearchAction({ query: q });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setError(null);
      setQuery("");
      router.push(`/contacts?f=${result.encoded}`);
    });
  }

  return (
    <div className="border-b border-border px-5 py-2">
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder='Ask in plain English — e.g. "biotech in Boston, not talked to since spring"'
          className="h-7 border-none bg-transparent text-[13px] shadow-none focus-visible:ring-0"
          disabled={pending}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={pending || !query.trim()}
          onClick={submit}
        >
          {pending ? "Compiling…" : "Search"}
        </Button>
      </div>
      {error && (
        <p className="mt-1 pl-6 text-xs text-muted-foreground">{error}</p>
      )}
    </div>
  );
}
