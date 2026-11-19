import Link from "next/link";
import { notFound } from "next/navigation";

import { Markdown } from "@/components/markdown";
import { CampaignEditor } from "@/components/outreach-forms";
import { requireAuth } from "@/lib/auth";
import { STAGE_LABEL, STAGE_ORDER, type Stage } from "@/lib/outreach/stage";
import { ownerTimezone } from "@/lib/settings";
import { formatInZone, localDateKey, now as currentTime } from "@/lib/time";
import { campaignPipeline, type PipelineMember } from "@/server/outreach-core";

export const dynamic = "force-dynamic";

// One campaign (SPEC §16): its goal and brief, and everyone in it grouped
// by where they stand. Nothing here is dragged or typed — each stage is
// read off the person's timeline.

const DAY = { day: "numeric", month: "short" } as const;

function detail(m: PipelineMember, zone: string): string {
  const day = (ms: number) => formatInZone(zone, ms, DAY);
  switch (m.stage) {
    case "awaiting_reply":
      return `${m.daysWaiting} day${m.daysWaiting === 1 ? "" : "s"} since your ${m.sentSinceReply > 1 ? "follow-up" : "email"}${m.nudgeDue ? " · follow-up due" : ""}`;
    case "dormant":
      return `${m.daysWaiting} days, ${m.sentSinceReply} email${m.sentSinceReply === 1 ? "" : "s"} unanswered`;
    case "your_move":
      return m.lastReceivedAt ? `they wrote ${day(m.lastReceivedAt)}` : "";
    case "call_booked":
      return m.callAt ? `on ${formatInZone(zone, m.callAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "";
    case "met":
      return m.since ? `${day(m.since)}` : "";
    case "drafted":
      return "a draft is waiting to be sent";
    case "bad_address":
      return "the last email bounced — needs another address";
    case "not_contacted":
      return m.lastContactBefore ? `last in touch ${day(m.lastContactBefore)}` : "never in touch";
    default:
      return "";
  }
}

export default async function CampaignPage({ params }: PageProps<"/outreach/[id]">) {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const { id } = await params;
  const groupId = Number(id);
  const pipeline = Number.isInteger(groupId) ? campaignPipeline(groupId, currentTime()) : null;
  if (!pipeline) notFound();
  const { campaign, members } = pipeline;
  const zone = ownerTimezone();
  const byStage = new Map<Stage, PipelineMember[]>();
  for (const m of members) byStage.set(m.stage, [...(byStage.get(m.stage) ?? []), m]);

  return (
    <div>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">
          <Link href="/outreach" className="text-muted-foreground hover:text-foreground">
            Outreach
          </Link>
          <span className="mx-1.5 text-muted-foreground">/</span>
          {campaign.name}
        </h1>
        <span className="text-xs text-muted-foreground">
          {members.length} {members.length === 1 ? "person" : "people"} · started {formatInZone(zone, campaign.startedAt, { day: "numeric", month: "short", year: "numeric" })}
          {campaign.archivedAt !== null ? " · archived" : ""}
        </span>
      </header>
      <div className="max-w-3xl space-y-6 px-5 py-4">
        <section className="space-y-2">
          <p className="text-[13px] font-medium">{campaign.goal}</p>
          {campaign.briefMd ? (
            <div className="rounded-md border border-border/60 bg-accent/20 px-3 py-2 text-xs">
              <Markdown>{campaign.briefMd}</Markdown>
            </div>
          ) : null}
          <CampaignEditor
            groupId={campaign.groupId}
            goal={campaign.goal}
            brief={campaign.briefMd}
            startedOn={localDateKey(zone, campaign.startedAt)}
            archived={campaign.archivedAt !== null}
          />
        </section>

        {members.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nobody in this campaign yet. Add people to the group &ldquo;{campaign.name}&rdquo; from the contacts list, or ask
            Claude to pick them.
          </p>
        ) : (
          STAGE_ORDER.filter((s) => byStage.has(s)).map((stage) => (
            <section key={stage} className="space-y-1.5" aria-label={STAGE_LABEL[stage]}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {STAGE_LABEL[stage]} <span className="font-normal">{byStage.get(stage)!.length}</span>
              </h2>
              <ol className="space-y-1">
                {byStage.get(stage)!.map((m) => (
                  <li key={m.contactId} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 rounded-md border border-border/60 px-3 py-2">
                    <Link href={`/contacts/${m.contactId}`} className="text-[13px] font-medium underline-offset-2 hover:underline">
                      {m.name}
                    </Link>
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {[m.title, m.company].filter(Boolean).join(" · ")}
                    </span>
                    {m.email === null ? <span className="text-[11px] text-amber-600 dark:text-amber-400">no email</span> : null}
                    <span className="flex-1" />
                    <span className="text-[11px] text-muted-foreground">{detail(m, zone)}</span>
                  </li>
                ))}
              </ol>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
