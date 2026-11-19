"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAuth } from "@/lib/auth";
import {
  discardDraft,
  editDraft,
  markDraftSent,
  saveCampaign,
  saveOutreachSettings,
  setCampaignArchived,
  startOfLocalDay,
} from "@/server/outreach-core";

// The Outreach pages' actions (SPEC §16). Every export is an endpoint,
// so every one starts with requireAuth; the rules are in outreach-core.

export type OutreachActionResult = { ok: true; message?: string } | { ok: false; error: string };

function refresh(contactId?: number): void {
  revalidatePath("/outreach");
  revalidatePath("/today");
  if (contactId) revalidatePath(`/contacts/${contactId}`);
}

export async function createCampaignAction(name: string, goal: string, brief: string): Promise<OutreachActionResult> {
  await requireAuth();
  const res = saveCampaign({ name: String(name ?? ""), goal: String(goal ?? ""), briefMd: String(brief ?? "") });
  if (!res.ok) return res;
  refresh();
  redirect(`/outreach/${res.groupId}`);
}

export async function updateCampaignAction(groupId: number, goal: string, brief: string, startedOn: string): Promise<OutreachActionResult> {
  await requireAuth();
  if (!Number.isInteger(groupId)) return { ok: false, error: "Unknown campaign." };
  const startedAt = startOfLocalDay(String(startedOn ?? ""));
  if (startedAt === null) return { ok: false, error: "Pick the day this outreach began." };
  const res = saveCampaign({ groupId, goal: String(goal ?? ""), briefMd: String(brief ?? ""), startedAt });
  if (!res.ok) return res;
  refresh();
  revalidatePath(`/outreach/${groupId}`);
  return { ok: true, message: "Saved." };
}

export async function archiveCampaignAction(groupId: number, archived: boolean): Promise<OutreachActionResult> {
  await requireAuth();
  const res = setCampaignArchived(groupId, archived === true);
  if (!res.ok) return res;
  refresh();
  revalidatePath(`/outreach/${groupId}`);
  return { ok: true };
}

export async function editDraftAction(draftId: number, subject: string, body: string): Promise<OutreachActionResult> {
  await requireAuth();
  const res = editDraft(draftId, { subject: String(subject ?? ""), body: String(body ?? "") });
  if (!res.ok) return res;
  refresh();
  return { ok: true, message: "Saved." };
}

export async function markDraftSentAction(draftId: number): Promise<OutreachActionResult> {
  await requireAuth();
  const res = markDraftSent(draftId);
  if (!res.ok) return res;
  refresh(res.contactId);
  return { ok: true, message: "Logged on their timeline." };
}

export async function discardDraftAction(draftId: number): Promise<OutreachActionResult> {
  await requireAuth();
  const res = discardDraft(draftId);
  if (!res.ok) return res;
  refresh(res.contactId);
  return { ok: true };
}

export async function saveOutreachSettingsAction(nudgeAfterDays: number, dormantAfterDays: number, bcc: string): Promise<OutreachActionResult> {
  await requireAuth();
  const res = saveOutreachSettings({ nudgeAfterDays: Number(nudgeAfterDays), dormantAfterDays: Number(dormantAfterDays), bcc: String(bcc ?? "") });
  if (!res.ok) return res;
  refresh();
  return { ok: true, message: "Saved." };
}
