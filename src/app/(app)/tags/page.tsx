import { TagManager } from "@/components/tag-manager";
import { requireAuth } from "@/lib/auth";
import { listTags } from "@/server/queries";

export const dynamic = "force-dynamic";

export default async function TagsPage() {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const tags = listTags();
  return (
    <div>
      <header className="flex items-center gap-3 border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">Tags</h1>
        <span className="text-xs text-muted-foreground">{tags.length}</span>
      </header>
      <TagManager tags={tags} />
    </div>
  );
}
