import "server-only";

import { and, desc, eq, isNotNull } from "drizzle-orm";

import { db } from "@/db/client";
import { interactions } from "@/db/schema";
import { VOICE_SNIPPETS_MAX, voiceContext } from "@/lib/ai/voice";
import { getSetting } from "@/lib/settings";

// The owner's voice, as the drafting features read it (SPEC §11,
// 2026-09-26). Settings-backed; the AI page's voice panel writes it.

export type VoiceSettings = {
  examples: string;
  guide: string | null;
  generatedAt: number | null;
  ownerName: string | null;
};

export function readVoiceSettings(): VoiceSettings {
  return {
    examples: getSetting<string>("ai.voice_examples") ?? "",
    guide: getSetting<string>("ai.voice_guide") ?? null,
    generatedAt: getSetting<number>("ai.voice_generated_at") ?? null,
    ownerName: getSetting<string>("ai.owner_name") ?? null,
  };
}

/** Opening lines of messages the owner sent on LinkedIn, newest first. */
export function outboundSnippets(limit = VOICE_SNIPPETS_MAX): string[] {
  return db
    .select({ title: interactions.title })
    .from(interactions)
    .where(
      and(
        eq(interactions.kind, "message"),
        eq(interactions.direction, "outbound"),
        isNotNull(interactions.title)
      )
    )
    .orderBy(desc(interactions.occurredAt))
    .limit(limit)
    .all()
    .map((r) => r.title as string);
}

/** System-prompt fragment for anything that writes as the owner. */
export function ownerVoiceContext(): string {
  const v = readVoiceSettings();
  return voiceContext(v.guide, v.ownerName);
}
