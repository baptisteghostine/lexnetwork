"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, GitMerge } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  mergeAction,
  type MergePreview,
  type MergeSideView,
} from "@/server/dedupe";
import type { MergeDecisions, MergeField } from "@/lib/dedupe/merge";

// Field-by-field merge (SPEC §10): two columns + result, per-field pick,
// provenance under each value, multi-value fields union with dedupe.

const FIELD_LABEL: Record<MergeField, string> = {
  firstName: "First name",
  lastName: "Last name",
  title: "Title",
  company: "Company",
  location: "Location",
  bio: "Bio",
  descriptionMd: "Description",
  birthday: "Birthday",
  photoPath: "Photo",
  cadence: "Cadence",
};

// contact_field_sources keys per merge field (provenance display).
const PROVENANCE_KEY: Partial<Record<MergeField, string>> = {
  firstName: "first_name",
  lastName: "last_name",
  title: "title",
  company: "company",
  location: "location",
  bio: "bio",
  birthday: "birthday",
};

function unionCount(a: string[], b: string[]): number {
  return new Set([...a, ...b].map((v) => v.toLowerCase())).size;
}

function SideHeader({ side, role }: { side: MergeSideView; role: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {role}
      </p>
      <Link
        href={`/contacts/${side.id}`}
        className="text-[13px] font-medium hover:text-primary"
      >
        {side.displayName}
      </Link>
      <p className="text-[11px] text-muted-foreground">
        {side.interactionCount} interactions · {side.noteCount} notes
      </p>
    </div>
  );
}

export function MergeScreen({ preview }: { preview: MergePreview }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<MergeDecisions>(
    preview.defaults
  );

  const { winner, loser } = preview;

  // Only fields where at least one side has a value are worth a row.
  const rows = useMemo(
    () =>
      preview.fields.filter(
        (f) => winner.fields[f] !== null || loser.fields[f] !== null
      ),
    [preview.fields, winner, loser]
  );

  const unions: { label: string; a: string[]; b: string[] }[] = [
    { label: "Emails", a: winner.emails, b: loser.emails },
    { label: "Phones", a: winner.phones, b: loser.phones },
    { label: "Socials", a: winner.socials, b: loser.socials },
    { label: "Tags", a: winner.tags, b: loser.tags },
    { label: "Groups", a: winner.groups, b: loser.groups },
  ];

  function confirm() {
    start(async () => {
      const result = await mergeAction({
        winnerId: winner.id,
        loserId: loser.id,
        decisions,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      router.push(`/contacts/${winner.id}`);
    });
  }

  return (
    <div className="max-w-3xl space-y-5 px-5 py-4">
      <div className="flex items-end justify-between gap-3">
        <div className="grid flex-1 grid-cols-2 gap-3">
          <SideHeader side={winner} role="Kept" />
          <SideHeader side={loser} role="Merged away" />
        </div>
        <Button size="sm" variant="outline" asChild>
          <Link
            href={`/duplicates/merge?winner=${loser.id}&loser=${winner.id}`}
          >
            <ArrowLeftRight className="size-3.5" />
            Swap
          </Link>
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Everything on the right — timeline, notes, tags, groups, reminders,
        relationships — moves onto the kept contact. Pick which value wins
        for each conflicting field. This is undoable from the Duplicates
        page until either contact is edited again.
      </p>

      <table className="w-full text-[13px]">
        <tbody>
          {rows.map((f) => {
            const provKey = PROVENANCE_KEY[f];
            return (
              <tr key={f} className="border-t border-border">
                <td className="w-28 py-2 pr-2 align-top text-xs text-muted-foreground">
                  {FIELD_LABEL[f]}
                </td>
                {(["winner", "loser"] as const).map((side) => {
                  const view = side === "winner" ? winner : loser;
                  const value = view.fields[f];
                  const chosen = decisions[f] === side;
                  return (
                    <td key={side} className="w-1/2 py-1.5 pr-2 align-top">
                      <label
                        className={`block cursor-pointer rounded-md border px-2 py-1.5 ${
                          chosen
                            ? "border-primary bg-accent"
                            : "border-transparent hover:border-border"
                        } ${value === null ? "opacity-50" : ""}`}
                      >
                        <input
                          type="radio"
                          name={`field-${f}`}
                          className="sr-only"
                          checked={chosen}
                          onChange={() =>
                            setDecisions((d) => ({ ...d, [f]: side }))
                          }
                        />
                        <span className="block whitespace-pre-wrap break-words">
                          {value ?? "—"}
                        </span>
                        {provKey && view.provenance[provKey] && (
                          <span className="block text-[10px] text-muted-foreground">
                            via {view.provenance[provKey]}
                          </span>
                        )}
                      </label>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      <section className="space-y-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Combined automatically
        </h2>
        <ul className="text-xs text-muted-foreground">
          {unions
            .filter((u) => u.a.length + u.b.length > 0)
            .map((u) => (
              <li key={u.label}>
                {u.label}: {u.a.length} + {u.b.length} →{" "}
                {unionCount(u.a, u.b)} after dedupe
              </li>
            ))}
        </ul>
      </section>

      <div className="flex items-center gap-2">
        <Button disabled={pending} onClick={confirm}>
          <GitMerge className="size-3.5" />
          {pending ? "Merging…" : `Merge into ${winner.displayName}`}
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}
