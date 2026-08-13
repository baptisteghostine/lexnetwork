"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MAPPING_TARGETS, type Mapping, type MappingTarget } from "@/lib/imports/mapping";
import type { FieldConflict, FieldWrite, ImportStats } from "@/lib/imports/types";

type Preview =
  | {
      token: string;
      kind: "csv";
      headers: string[];
      totalRows: number;
      sampleRows: string[][];
      suggestedMapping: Mapping;
      usedSavedTemplate: boolean;
      signature: string;
    }
  | {
      token: string;
      kind: "vcard";
      totalRows: number;
      sample: { name: string; company: string; emails: number }[];
    };

type DryRunPlan = {
  status: string;
  displayName: string;
  matchedBy: string | null;
  writes: FieldWrite[];
  conflicts: FieldConflict[];
  newEmails: number;
  newPhones: number;
  error?: string;
};

const TARGET_LABELS: Record<MappingTarget, string> = {
  ignore: "— ignore —",
  first_name: "First name",
  last_name: "Last name",
  full_name: "Full name",
  title: "Title",
  company: "Company",
  location: "Location",
  bio: "Bio / notes",
  birthday: "Birthday",
  email: "Email",
  phone: "Phone",
  linkedin: "LinkedIn URL",
  website: "Website",
};

export function ImportFlow() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Mapping>([]);
  const [dryRun, setDryRun] = useState<{ stats: ImportStats; plans: DryRunPlan[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<number | null>(null);

  const upload = async (file: File) => {
    setBusy("Parsing…");
    setError(null);
    setDryRun(null);
    setDuplicateOf(null);
    const fd = new FormData();
    fd.set("file", file);
    const res = await fetch("/api/imports/preview", { method: "POST", body: fd });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) {
      setError(data.error ?? "Upload failed.");
      return;
    }
    setPreview(data);
    if (data.kind === "csv") setMapping(data.suggestedMapping);
  };

  const run = async (asDryRun: boolean, force = false) => {
    if (!preview) return;
    setBusy(asDryRun ? "Computing diff…" : "Importing…");
    setError(null);
    const res = await fetch("/api/imports/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: preview.token,
        kind: preview.kind,
        mapping: preview.kind === "csv" ? mapping : undefined,
        signature: preview.kind === "csv" ? preview.signature : undefined,
        dryRun: asDryRun,
        force,
      }),
    });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) {
      setError(data.error ?? "Import failed.");
      return;
    }
    if (data.duplicateOf) {
      setDuplicateOf(data.duplicateOf);
      return;
    }
    if (asDryRun) {
      setDryRun(data);
    } else {
      router.push(`/imports/${data.runId}`);
    }
  };

  return (
    <div className="max-w-3xl space-y-5 px-5 py-4">
      {!preview && (
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border py-10 text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground">
          <FileUp className="size-6" />
          <span className="text-[13px]">
            Choose a CSV or vCard (.vcf) file
          </span>
          <span className="text-[11px]">
            Google Contacts exports map automatically
          </span>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.vcf,text/csv,text/vcard"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
        </label>
      )}

      {preview?.kind === "csv" && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">
              Map columns · {preview.totalRows} rows
            </h2>
            {preview.usedSavedTemplate && (
              <span className="text-[11px] text-muted-foreground">
                using your saved mapping for this file shape
              </span>
            )}
          </div>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-[12px]">
              <tbody>
                {preview.headers.map((h, i) => (
                  <tr key={i} className="border-b border-border/60 last:border-0">
                    <td className="max-w-40 truncate px-2.5 py-1.5 font-medium">
                      {h}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <select
                        className="h-7 rounded-md border border-input bg-transparent px-1.5 text-[12px]"
                        value={mapping[i]}
                        onChange={(e) => {
                          const next = [...mapping];
                          next[i] = e.target.value as MappingTarget;
                          setMapping(next);
                        }}
                      >
                        {MAPPING_TARGETS.map((t) => (
                          <option key={t} value={t} className="bg-popover">
                            {TARGET_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="max-w-64 truncate px-2.5 py-1.5 text-muted-foreground">
                      {preview.sampleRows
                        .map((r) => r[i])
                        .filter(Boolean)
                        .slice(0, 2)
                        .join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {preview?.kind === "vcard" && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">
            {preview.totalRows} vCards found
          </h2>
          <ul className="text-[12px] text-muted-foreground">
            {preview.sample.map((s, i) => (
              <li key={i}>
                {s.name}
                {s.company ? ` — ${s.company}` : ""} · {s.emails} email(s)
              </li>
            ))}
            {preview.totalRows > preview.sample.length && <li>…</li>}
          </ul>
        </section>
      )}

      {preview && (
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={!!busy} onClick={() => run(true)}>
            Dry run (no changes)
          </Button>
          <Button disabled={!!busy} onClick={() => run(false)}>
            Import
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setPreview(null);
              setDryRun(null);
              setError(null);
              setDuplicateOf(null);
            }}
          >
            Start over
          </Button>
          {busy && <span className="text-xs text-muted-foreground">{busy}</span>}
        </div>
      )}

      {duplicateOf !== null && (
        <div className="space-y-2 rounded-md border border-border p-3 text-[13px]">
          <p>
            This exact file was already imported —{" "}
            <a href={`/imports/${duplicateOf}`} className="text-blue-400 hover:underline">
              see that report
            </a>
            .
          </p>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run(false, true)}>
            Import anyway
          </Button>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {dryRun && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Dry run result</h2>
          <StatsRow stats={dryRun.stats} />
          <ul className="max-h-96 space-y-1 overflow-y-auto text-[12px]">
            {dryRun.plans
              .filter((p) => p.status !== "unchanged")
              .map((p, i) => (
                <li key={i} className="rounded border border-border/60 px-2.5 py-1.5">
                  <span
                    className={
                      p.status === "conflict"
                        ? "text-warning"
                        : p.status === "error"
                          ? "text-destructive"
                          : p.status === "new"
                            ? "text-success"
                            : "text-blue-400"
                    }
                  >
                    {p.status}
                  </span>{" "}
                  <span className="font-medium">{p.displayName}</span>
                  {p.matchedBy && (
                    <span className="text-muted-foreground"> · matched by {p.matchedBy}</span>
                  )}
                  {p.writes.length > 0 && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {p.writes.map((w) => w.field).join(", ")}
                    </span>
                  )}
                  {p.conflicts.length > 0 && (
                    <span className="text-warning/80">
                      {" "}
                      · conflicts: {p.conflicts.map((c) => c.field).join(", ")}
                    </span>
                  )}
                  {p.error && <span className="text-destructive"> · {p.error}</span>}
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function StatsRow({ stats }: { stats: ImportStats }) {
  const cell = (label: string, n: number, cls = "") => (
    <div className="rounded-md border border-border px-3 py-1.5 text-center">
      <div className={`text-sm font-semibold ${cls}`}>{n}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
  return (
    <div className="flex gap-2">
      {cell("total", stats.total)}
      {cell("new", stats.new, "text-success")}
      {cell("updated", stats.updated, "text-blue-400")}
      {cell("unchanged", stats.unchanged)}
      {cell("conflicts", stats.conflicts, "text-warning")}
      {cell("errors", stats.errors, stats.errors ? "text-destructive" : "")}
    </div>
  );
}
