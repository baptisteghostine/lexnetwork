import Link from "next/link";

import { DraftCard } from "@/components/draft-card";
import { NewCampaignForm, OutreachSettingsForm } from "@/components/outreach-forms";
import { requireAuth } from "@/lib/auth";
import { DRAFT_KINDS, type DraftKind } from "@/lib/outreach/compose";
import { STAGE_LABEL, STAGE_ORDER } from "@/lib/outreach/stage";
import { ownerTimezone } from "@/lib/settings";
import { formatInZone, now as currentTime } from "@/lib/time";
import { listCampaigns, listDrafts, outreachSettings } from "@/server/outreach-core";

export const dynamic = "force-dynamic";

// Outreach (SPEC §16): the drafts waiting to be sent, and the campaigns
// they belong to.

export default async function OutreachPage() {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const now = currentTime();
  const zone = ownerTimezone();
  const drafts = listDrafts({ status: "open" });
  const campaigns = listCampaigns(now);
  const settings = outreachSettings();
  const live = campaigns.filter((c) => c.archivedAt === null);
  const archived = campaigns.filter((c) => c.archivedAt !== null);

  return (
    <div>
      <header className="flex items-center gap-3 border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">Outreach</h1>
        <span className="text-xs text-muted-foreground">
          {drafts.length} draft{drafts.length === 1 ? "" : "s"} to send · {live.length} campaign{live.length === 1 ? "" : "s"}
        </span>
      </header>
      <div className="max-w-3xl space-y-8 px-5 py-4">
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Drafts to send</h2>
          {drafts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing waiting. Ask Claude to draft for a campaign and the emails appear here, ready to open in Outlook. Rolo
              never sends anything itself.
            </p>
          ) : (
            <ol className="space-y-3">
              {drafts.map((d) => (
                <DraftCard
                  key={d.id}
                  bcc={settings.bcc}
                  draft={{
                    id: d.id,
                    contactId: d.contactId,
                    contactName: d.contactName,
                    campaignName: d.campaignName,
                    kind: (DRAFT_KINDS as readonly string[]).includes(d.kind) ? (d.kind as DraftKind) : "other",
                    toEmail: d.toEmail,
                    subject: d.subject,
                    body: d.body,
                    writtenBy: d.source === "agent" ? "agent" : "user",
                    written: formatInZone(zone, d.createdAt, { day: "numeric", month: "short" }),
                  }}
                />
              ))}
            </ol>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Campaigns</h2>
          {live.length === 0 ? (
            <p className="text-xs text-muted-foreground">No campaign yet. Create one below, or ask Claude to set one up from a goal.</p>
          ) : (
            <ul className="space-y-2">
              {live.map((c) => (
                <li key={c.groupId}>
                  <Link href={`/outreach/${c.groupId}`} className="block rounded-md border border-border px-3 py-2.5 transition-colors hover:bg-accent/50">
                    <p className="text-[13px] font-medium">
                      {c.name}
                      <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                        {c.members} {c.members === 1 ? "person" : "people"}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{c.goal}</p>
                    <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      {STAGE_ORDER.filter((s) => c.byStage[s] > 0).map((s) => (
                        <span key={s}>
                          <span className="font-medium text-foreground">{c.byStage[s]}</span> {STAGE_LABEL[s].toLowerCase()}
                        </span>
                      ))}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {archived.length > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Archived:{" "}
              {archived.map((c, i) => (
                <span key={c.groupId}>
                  {i > 0 ? ", " : ""}
                  <Link href={`/outreach/${c.groupId}`} className="underline-offset-2 hover:underline">
                    {c.name}
                  </Link>
                </span>
              ))}
            </p>
          ) : null}
          <details className="rounded-md border border-border p-3 text-xs">
            <summary className="cursor-pointer select-none font-medium">New campaign</summary>
            <div className="mt-3">
              <NewCampaignForm />
            </div>
          </details>
        </section>

        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Settings</h2>
          <OutreachSettingsForm nudgeAfterDays={settings.nudgeAfterDays} dormantAfterDays={settings.dormantAfterDays} bcc={settings.bcc ?? ""} />
        </section>
      </div>
    </div>
  );
}
