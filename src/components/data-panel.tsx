"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { backupNowAction, type DataStatus } from "@/server/data";

// Settings → Data: one-click export, backup health, back-up-now.

function timeAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function DataPanel({ status }: { status: DataStatus }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const b = status.backup;

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">Export everything</div>
          <p className="text-xs text-muted-foreground">
            ZIP with contacts.csv, per-table JSON, and attachments.
            {status.lastExport
              ? ` Last export ${timeAgo(status.lastExport.at)} (${status.lastExport.status}).`
              : ""}
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          {/* A plain link, not fetch — the browser streams the download. */}
          <a href="/api/export" download>
            Download export
          </a>
        </Button>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">Backups</div>
          <p className="text-xs text-muted-foreground">
            Nightly <code>VACUUM INTO data/backups/</code>, kept 30 days.{" "}
            {b.lastSuccessAt
              ? `Last success ${timeAgo(b.lastSuccessAt)}${
                  b.lastSizeBytes ? ` · ${formatSize(b.lastSizeBytes)}` : ""
                }${b.lastFileName ? ` · ${b.lastFileName}` : ""}.`
              : "No backup has succeeded yet."}
          </p>
          {b.lastFailure ? (
            <p className="text-xs text-red-600 dark:text-red-400">
              Last failure {timeAgo(b.lastFailure.at)}:{" "}
              {b.lastFailure.error.slice(0, 200)}
            </p>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setResult(null);
              setError(null);
              const r = await backupNowAction();
              if (r.error) setError(r.error);
              else setResult(`Backed up to ${r.fileName}.`);
            })
          }
        >
          {pending ? "Backing up…" : "Back up now"}
        </Button>
      </div>
      {result ? (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">{result}</p>
      ) : null}
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}
    </div>
  );
}
