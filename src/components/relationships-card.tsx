"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addRelationshipAction,
  removeRelationshipAction,
  type RelationshipEdge,
} from "@/server/relationships";

// Related contacts on the profile (SPEC §10): edges + labels, with a
// small add flow. Directed labels read A→B ("introduced by" renders with
// an arrow toward the introducer).

const LABEL_SUGGESTIONS = [
  "introduced_by",
  "colleague",
  "friend",
  "spouse",
  "family",
  "knows",
] as const;

type ContactHit = { id: number; name: string };

export function RelationshipsCard({
  contactId,
  edges,
}: {
  contactId: number;
  edges: RelationshipEdge[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [other, setOther] = useState<ContactHit | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [label, setLabel] = useState("colleague");
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const mySeq = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { results: ContactHit[] };
        if (mySeq === seq.current) {
          setHits(data.results.filter((h) => h.id !== contactId).slice(0, 5));
        }
      } catch {
        // ignore network hiccups
      }
    }, 150);
    return () => clearTimeout(t);
  }, [query, contactId]);

  function add() {
    if (!other) return;
    start(async () => {
      const result = await addRelationshipAction({
        contactId,
        otherId: other.id,
        label,
        directed: label === "introduced_by",
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setOther(null);
      setQuery("");
      setAdding(false);
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Related contacts
        </h3>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5"
          aria-label="Add relationship"
          onClick={() => setAdding((v) => !v)}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      {edges.length === 0 && !adding ? (
        <p className="text-xs text-muted-foreground">None linked yet.</p>
      ) : (
        <ul className="space-y-1">
          {edges.map((e) => (
            <li key={e.id} className="group flex items-center gap-1.5 text-[13px]">
              {e.direction === "out" ? (
                <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
              ) : e.direction === "in" ? (
                <ArrowLeft className="size-3 shrink-0 text-muted-foreground" />
              ) : null}
              <span className="text-muted-foreground">
                {e.label.replaceAll("_", " ")}
              </span>
              <Link
                href={`/contacts/${e.otherId}`}
                className="min-w-0 flex-1 truncate font-medium hover:text-primary"
              >
                {e.otherName}
              </Link>
              <button
                aria-label={`Remove ${e.label} link to ${e.otherName}`}
                className="opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    await removeRelationshipAction({ id: e.id });
                    router.refresh();
                  })
                }
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="space-y-1.5">
          {other ? (
            <div className="flex items-center gap-1.5 text-[13px]">
              <span className="font-medium">{other.name}</span>
              <button
                aria-label="Clear selected contact"
                onClick={() => setOther(null)}
              >
                <X className="size-3" />
              </button>
            </div>
          ) : (
            <>
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (!e.target.value.trim()) setHits([]);
                }}
                placeholder="Type to find a contact…"
                className="h-7 text-xs"
              />
              {hits.length > 0 && (
                <ul className="rounded-md border border-border bg-popover text-[13px]">
                  {hits.map((h) => (
                    <li key={h.id}>
                      <button
                        className="w-full px-2 py-1 text-left hover:bg-accent"
                        onClick={() => {
                          setOther(h);
                          setHits([]);
                        }}
                      >
                        {h.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <div className="flex items-center gap-1.5">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              list="relationship-labels"
              className="h-7 w-32 text-xs"
              placeholder="label"
            />
            <datalist id="relationship-labels">
              {LABEL_SUGGESTIONS.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
            <Button
              size="sm"
              className="h-7"
              disabled={pending || !other || !label.trim()}
              onClick={add}
            >
              Link
            </Button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}
    </div>
  );
}
