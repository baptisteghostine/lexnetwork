import { GroupManager } from "@/components/group-manager";
import { requireAuth } from "@/lib/auth";
import { listGroups } from "@/server/queries";

export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const groups = listGroups();
  return (
    <div>
      <header className="flex items-center gap-3 border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">Groups</h1>
        <span className="text-xs text-muted-foreground">{groups.length}</span>
      </header>
      <GroupManager groups={groups} />
    </div>
  );
}
