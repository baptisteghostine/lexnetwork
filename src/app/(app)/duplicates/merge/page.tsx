import Link from "next/link";

import { MergeScreen } from "@/components/merge-screen";
import { requireAuth } from "@/lib/auth";
import { readMergePreview } from "@/server/dedupe";

export const dynamic = "force-dynamic";

export default async function MergePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAuth();
  const params = await searchParams;
  const winnerId = Number(params.winner);
  const loserId = Number(params.loser);

  const invalid =
    !Number.isInteger(winnerId) ||
    !Number.isInteger(loserId) ||
    winnerId === loserId;
  const preview = invalid
    ? { error: "Pick two different contacts to merge." }
    : await readMergePreview({ winnerId, loserId });

  return (
    <div>
      <header className="flex items-center justify-between border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">Merge contacts</h1>
        <Link
          href="/duplicates"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Back to duplicates
        </Link>
      </header>
      {"error" in preview ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          {preview.error}
        </p>
      ) : (
        <MergeScreen preview={preview} />
      )}
    </div>
  );
}
