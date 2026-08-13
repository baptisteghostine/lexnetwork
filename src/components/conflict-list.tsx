"use client";

import { useState, useTransition } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { FieldConflict } from "@/lib/imports/types";
import { acceptConflictAction } from "@/server/imports";
import type { ScalarField } from "@/lib/imports/types";

type ConflictRow = {
  contactId: number;
  displayName: string;
  conflict: FieldConflict & { accepted?: boolean };
};

export function ConflictList({
  runId,
  rows,
}: {
  runId: number;
  rows: ConflictRow[];
}) {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (rows.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-yellow-500">
        Conflicts — stored value kept, review each
      </h2>
      <ul className="space-y-1">
        {rows.map((r, i) => {
          const key = `${r.contactId}:${r.conflict.field}`;
          return (
            <li
              key={i}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-[12.5px]"
            >
              <Link
                href={`/contacts/${r.contactId}`}
                className="w-40 truncate font-medium hover:underline"
              >
                {r.displayName}
              </Link>
              <span className="text-muted-foreground">{r.conflict.field}:</span>
              <span>
                kept{" "}
                <span className="font-medium">“{r.conflict.stored}”</span>
                <span className="text-[10px] text-muted-foreground">
                  {" "}
                  ({r.conflict.storedSource})
                </span>
              </span>
              <span className="text-muted-foreground">vs incoming</span>
              <span className="font-medium">“{r.conflict.incoming}”</span>
              <span className="flex-1" />
              {r.conflict.accepted ? (
                <span className="text-[11px] text-green-500">
                  incoming accepted
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await acceptConflictAction({
                        runId,
                        contactId: r.contactId,
                        field: r.conflict.field as ScalarField,
                        value: r.conflict.incoming,
                      });
                      if (res.error) {
                        setErrors((e) => ({ ...e, [key]: res.error as string }));
                      }
                    })
                  }
                >
                  Accept incoming
                </Button>
              )}
              {errors[key] && (
                <span className="text-[11px] text-destructive">
                  {errors[key]}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
