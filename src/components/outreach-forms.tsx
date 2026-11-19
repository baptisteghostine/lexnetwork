"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  archiveCampaignAction,
  createCampaignAction,
  saveOutreachSettingsAction,
  updateCampaignAction,
  type OutreachActionResult,
} from "@/server/outreach";

// The small forms of the Outreach pages (SPEC §16).

function Result({ result }: { result: OutreachActionResult | null }) {
  if (!result) return null;
  return (
    <p role={result.ok ? "status" : "alert"} className={`text-xs ${result.ok ? "text-muted-foreground" : "text-destructive"}`}>
      {result.ok ? result.message : result.error}
    </p>
  );
}

export function NewCampaignForm() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<OutreachActionResult | null>(null);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [brief, setBrief] = useState("");
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setResult(await createCampaignAction(name, goal, brief)));
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="campaign-name" className="text-[11px]">Name</Label>
        <Input id="campaign-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tech investment banking — autumn" maxLength={80} required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="campaign-goal" className="text-[11px]">Goal, in one line</Label>
        <Input id="campaign-goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Coffee chats with TMT bankers at the top firms" maxLength={200} required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="campaign-brief" className="text-[11px]">Brief (optional): who fits, the angle, what you are asking for</Label>
        <Textarea id="campaign-brief" value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} maxLength={8000} />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "…" : "Create campaign"}
      </Button>
      <Result result={result} />
    </form>
  );
}

export function CampaignEditor({
  groupId,
  goal: initialGoal,
  brief: initialBrief,
  startedOn: initialStartedOn,
  archived,
}: {
  groupId: number;
  goal: string;
  brief: string;
  /** YYYY-MM-DD in the owner's timezone. */
  startedOn: string;
  archived: boolean;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<OutreachActionResult | null>(null);
  const [goal, setGoal] = useState(initialGoal);
  const [brief, setBrief] = useState(initialBrief);
  const [startedOn, setStartedOn] = useState(initialStartedOn);
  return (
    <details className="text-xs">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">Edit goal, brief and start date</summary>
      <form
        className="mt-2 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => setResult(await updateCampaignAction(groupId, goal, brief, startedOn)));
        }}
      >
        <Input aria-label="Goal" value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={200} required />
        <Textarea aria-label="Brief" value={brief} onChange={(e) => setBrief(e.target.value)} rows={8} maxLength={8000} />
        <div className="space-y-1">
          <Label htmlFor="campaign-started" className="text-[11px]">Count what was sent since</Label>
          <Input id="campaign-started" type="date" value={startedOn} onChange={(e) => setStartedOn(e.target.value)} className="h-8 w-40" required />
          <p className="text-muted-foreground">Emails from before this day are not part of this campaign. Move it back if you started writing to these people earlier.</p>
        </div>
        <div className="flex gap-1.5">
          <Button type="submit" size="sm" disabled={pending}>Save</Button>
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => start(async () => setResult(await archiveCampaignAction(groupId, !archived)))}>
            {archived ? "Reopen campaign" : "Archive campaign"}
          </Button>
        </div>
        <Result result={result} />
      </form>
    </details>
  );
}

export function OutreachSettingsForm({ nudgeAfterDays, dormantAfterDays, bcc }: { nudgeAfterDays: number; dormantAfterDays: number; bcc: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<OutreachActionResult | null>(null);
  const [nudge, setNudge] = useState(String(nudgeAfterDays));
  const [dormant, setDormant] = useState(String(dormantAfterDays));
  const [address, setAddress] = useState(bcc);
  return (
    <form
      className="space-y-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setResult(await saveOutreachSettingsAction(Number(nudge), Number(dormant), address)));
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="outreach-nudge" className="text-[11px]">Follow-up is due after (days)</Label>
          <Input id="outreach-nudge" type="number" min={1} max={60} value={nudge} onChange={(e) => setNudge(e.target.value)} className="h-8 w-24" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="outreach-dormant" className="text-[11px]">Counts as &ldquo;no reply&rdquo; after (days)</Label>
          <Input id="outreach-dormant" type="number" min={2} max={365} value={dormant} onChange={(e) => setDormant(e.target.value)} className="h-8 w-24" />
        </div>
        <div className="min-w-56 flex-1 space-y-1">
          <Label htmlFor="outreach-bcc" className="text-[11px]">BCC on every draft (optional)</Label>
          <Input id="outreach-bcc" type="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="your-forwarding-address@gmail.com" className="h-8" />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>Save</Button>
      </div>
      <p className="text-muted-foreground">
        A BCC to the mailbox Claude reads means each email you send arrives there at once, with its real recipient and time —
        no forwarding by hand. Check once that your school&apos;s Outlook keeps the BCC when it opens the draft.
      </p>
      <Result result={result} />
    </form>
  );
}
