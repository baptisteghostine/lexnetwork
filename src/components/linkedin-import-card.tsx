"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BriefcaseBusiness, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";

// The monthly ritual, made obvious (SPEC Phase 7): when did you last
// import, where to get a fresh export, one click to drop the ZIP.
// `daysAgo` computed server-side (render must stay pure).
export function LinkedInImportCard({ daysAgo }: { daysAgo: number | null }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<number | null>(null);

  const nudge =
    daysAgo === null
      ? "Never imported — your LinkedIn network is one ZIP away."
      : daysAgo >= 30
        ? `Last import ${daysAgo} days ago — time for a fresh export.`
        : `Last import ${daysAgo === 0 ? "today" : `${daysAgo} days ago`}.`;

  async function upload(file: File, force = false) {
    setBusy(true);
    setError(null);
    setDuplicateOf(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      if (force) fd.set("force", "1");
      const res = await fetch("/api/imports/linkedin", {
        method: "POST",
        body: fd,
      });
      const data = (await res.json()) as {
        runId?: number;
        duplicateOf?: number;
        error?: string;
      };
      if (data.runId) {
        router.push(`/imports/${data.runId}`);
        return;
      }
      if (data.duplicateOf) {
        setDuplicateOf(data.duplicateOf);
        return;
      }
      setError(data.error ?? "Import failed.");
    } catch {
      setError("Upload failed — is the server reachable?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-5 mt-4 max-w-3xl rounded-md border border-primary/25 bg-accent/40 p-4">
      <div className="flex items-start gap-3">
        <BriefcaseBusiness className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold">LinkedIn import</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {nudge} Rolo diffs each export against the last one: new
            connections, job changes as reasons to reach out, and message
            history feeding keep-in-touch.
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Get the ZIP from{" "}
            <a
              href="https://www.linkedin.com/mypreferences/d/download-my-data"
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              LinkedIn → Settings → Get a copy of your data
            </a>{" "}
            (choose “Connections” and “Messages”).
          </p>
          {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
          {duplicateOf !== null ? (
            <p className="mt-2 text-xs text-muted-foreground">
              This exact file was already imported —{" "}
              <a href={`/imports/${duplicateOf}`} className="text-primary hover:underline">
                see that report
              </a>{" "}
              or{" "}
              <button
                className="text-primary hover:underline"
                onClick={() => {
                  const f = fileRef.current?.files?.[0];
                  if (f) void upload(f, true);
                }}
              >
                re-run it anyway
              </button>
              .
            </p>
          ) : null}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        <Button
          size="sm"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="size-3.5" />
          {busy ? "Importing…" : "Upload ZIP"}
        </Button>
      </div>
    </section>
  );
}
