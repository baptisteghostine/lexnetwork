"use server";

import { revalidatePath } from "next/cache";

import { requireAuth } from "@/lib/auth";
import { setSetting } from "@/lib/settings";
import {
  AGENT_WRITE_MODE_KEY,
  approveQueuedCall,
  rejectQueuedCall,
} from "@/server/agent/tools";
import { undoAgentCall } from "@/server/agent/undo";

// What the owner does about an agent's writes (SPEC §14, Phase 15): take
// one back, approve or turn down a proposal, and choose whether writes
// apply at once or wait. Every export is an endpoint, so every one starts
// with requireAuth; the logic is in plain modules.

export type OwnerActionResult = { ok: true; message: string } | { ok: false; error: string };

function refresh(contactId: number | null | undefined): void {
  revalidatePath("/agent-activity");
  revalidatePath("/settings");
  revalidatePath("/today");
  revalidatePath("/contacts");
  if (contactId) revalidatePath(`/contacts/${contactId}`);
}

export async function undoAgentCallAction(callId: number): Promise<OwnerActionResult> {
  await requireAuth();
  if (!Number.isInteger(callId)) return { ok: false, error: "Unknown action." };
  const res = undoAgentCall(callId);
  if (!res.ok) return res;
  refresh(res.contactId);
  const kept = res.skipped.length ? ` Kept: ${res.skipped.join("; ")}.` : "";
  return {
    ok: true,
    message: `${res.reversed.length ? `Undone — ${res.reversed.join("; ")}.` : "Nothing was left to undo."}${kept}`,
  };
}

export async function approveAgentCallAction(callId: number): Promise<OwnerActionResult> {
  await requireAuth();
  if (!Number.isInteger(callId)) return { ok: false, error: "Unknown proposal." };
  const res = approveQueuedCall(callId);
  refresh(null);
  if (!res.ok) return res;
  return { ok: true, message: res.summary ?? "Applied." };
}

export async function rejectAgentCallAction(callId: number): Promise<OwnerActionResult> {
  await requireAuth();
  if (!Number.isInteger(callId)) return { ok: false, error: "Unknown proposal." };
  const done = rejectQueuedCall(callId);
  refresh(null);
  return done ? { ok: true, message: "Rejected." } : { ok: false, error: "That proposal is no longer waiting." };
}

export async function setAgentWriteModeAction(mode: string): Promise<void> {
  await requireAuth();
  setSetting(AGENT_WRITE_MODE_KEY, mode === "review" ? "review" : "apply");
  revalidatePath("/settings");
  revalidatePath("/agent-activity");
}
