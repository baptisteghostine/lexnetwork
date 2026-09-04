import { TodaySuggestions } from "@/components/today-suggestions";
import { requireAuth } from "@/lib/auth";
import { now as currentTime } from "@/lib/time";
import { openSuggestions } from "@/server/sync/suggestions";

export const dynamic = "force-dynamic";

// The whole "People you met" queue (SPEC §9f) — Today shows the top few.
export default async function PeopleYouMetPage() {
  await requireAuth();
  const now = currentTime();
  const { rows, total } = openSuggestions(now, 200);
  return (
    <div>
      <header className="flex items-center gap-3 border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">People you met</h1>
        <span className="text-xs text-muted-foreground">
          {total === 0 ? "nobody waiting" : `${total} not in Rolo yet`}
        </span>
      </header>
      <div className="max-w-3xl space-y-3 px-5 py-4">
        <p className="text-[12px] text-muted-foreground">
          People on your calendar and in your email that Rolo doesn&apos;t know.
          Adding one brings the meetings and messages it already saw onto
          their timeline. Dismissing one is permanent.
        </p>
        {rows.length > 0 ? (
          <TodaySuggestions items={rows} now={now} total={total} showAllLink={false} />
        ) : (
          <p className="text-[13px] text-muted-foreground">Nobody waiting.</p>
        )}
      </div>
    </div>
  );
}
