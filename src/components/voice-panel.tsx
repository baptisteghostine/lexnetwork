"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildVoiceGuideAction, saveVoiceAction, type VoiceView } from "@/server/ai";

// "Your voice" (SPEC §11, 2026-09-26): the style guide every draft
// follows. Built from the owner's own sent messages, then editable — the
// owner has the last word on how they sound.

export function VoicePanel({ initial }: { initial: VoiceView }) {
  const router = useRouter();
  const [ownerName, setOwnerName] = useState(initial.ownerName ?? "");
  const [examples, setExamples] = useState(initial.examples);
  const [guide, setGuide] = useState(initial.guide ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = (then?: () => Promise<void>) =>
    start(async () => {
      const res = await saveVoiceAction({ ownerName, examples, guide });
      if (res.error) {
        setMessage(res.error);
        return;
      }
      if (then) await then();
      else setMessage("Saved.");
      router.refresh();
    });

  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Your voice
      </h2>
      <p className="text-xs text-muted-foreground">
        Every draft Rolo writes follows this guide. Build it from the{" "}
        {initial.sampleCount} message{initial.sampleCount === 1 ? "" : "s"} you sent on
        LinkedIn (from the ZIP import), plus anything you paste below — then edit it
        until it sounds like you.
      </p>
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Your name, as you sign</Label>
          <Input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Baptiste" />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">
          Messages you wrote (optional — paste 3–5 you&rsquo;re happy with)
        </Label>
        <textarea
          value={examples}
          onChange={(e) => setExamples(e.target.value)}
          rows={5}
          placeholder={"Hi Kate,\n\nIt's Baptiste from LBS — we met at…"}
          className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-[11px] text-muted-foreground">
            Style guide{initial.generatedAt ? ` · built ${new Date(initial.generatedAt).toLocaleDateString()}` : ""}
          </Label>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              save(async () => {
                const res = await buildVoiceGuideAction();
                if (res.error) setMessage(res.error);
                else {
                  setGuide(res.guide ?? "");
                  setMessage("Guide built from your messages — edit anything that doesn't sound like you.");
                }
              })
            }
          >
            <Sparkles className="size-3.5" />
            {guide ? "Rebuild from my messages" : "Build from my messages"}
          </Button>
        </div>
        <textarea
          value={guide}
          onChange={(e) => setGuide(e.target.value)}
          rows={8}
          placeholder="No guide yet. Build one, or write how you like to sound: greeting, length, tone, how you close…"
          className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={pending} onClick={() => save()}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {message && <span className="text-xs text-muted-foreground">{message}</span>}
      </div>
    </section>
  );
}
