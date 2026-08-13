import { DuplicatesQueue } from "@/components/duplicates-queue";
import { requireAuth } from "@/lib/auth";
import { readDuplicates } from "@/server/dedupe";

export const dynamic = "force-dynamic";

export default async function DuplicatesPage() {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const { queue, recentMerges } = await readDuplicates();
  return (
    <div>
      <header className="flex items-center justify-between border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">
          Duplicates
          {queue.length > 0 && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {queue.length} suggestion{queue.length === 1 ? "" : "s"}
            </span>
          )}
        </h1>
      </header>
      <DuplicatesQueue queue={queue} recentMerges={recentMerges} />
    </div>
  );
}
