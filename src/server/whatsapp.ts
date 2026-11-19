"use server";

import { revalidatePath } from "next/cache";

import { requireAuth } from "@/lib/auth";
import { ownerTimezone } from "@/lib/settings";
import { fromFakeUtc } from "@/lib/time";
import { deleteWhatsAppData, linkWhatsApp, updateWhatsAppLink } from "@/server/whatsapp-core";

// The WhatsApp panel's actions (SPEC §15). Every export is an endpoint,
// so every one starts with requireAuth; the rules are in whatsapp-core.

export type WhatsAppActionResult = { ok: true; message?: string } | { ok: false; error: string };

function refresh(contactId: number): void {
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/today");
  revalidatePath("/timeline");
}

export async function linkWhatsAppAction(contactId: number, number: string, savedName: string): Promise<WhatsAppActionResult> {
  await requireAuth();
  if (!Number.isInteger(contactId)) return { ok: false, error: "Unknown contact." };
  const res = linkWhatsApp(contactId, { number: String(number ?? ""), savedName: String(savedName ?? "") });
  if (!res.ok) return res;
  refresh(contactId);
  return { ok: true };
}

export async function setWhatsAppSyncAction(contactId: number, enabled: boolean): Promise<WhatsAppActionResult> {
  await requireAuth();
  const res = updateWhatsAppLink(contactId, { syncEnabled: enabled === true });
  if (!res.ok) return res;
  refresh(contactId);
  return { ok: true };
}

/** `date` is YYYY-MM-DD, read as the start of that day where the owner is; empty clears it. */
export async function setWhatsAppHistoryFromAction(contactId: number, date: string): Promise<WhatsAppActionResult> {
  await requireAuth();
  let syncFrom: number | null = null;
  if (date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
    if (!match) return { ok: false, error: "That is not a date." };
    syncFrom = fromFakeUtc(ownerTimezone(), Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }
  const res = updateWhatsAppLink(contactId, { syncFrom });
  if (!res.ok) return res;
  refresh(contactId);
  return { ok: true };
}

export async function renameWhatsAppAction(contactId: number, savedName: string): Promise<WhatsAppActionResult> {
  await requireAuth();
  const res = updateWhatsAppLink(contactId, { savedName: String(savedName ?? "") });
  if (!res.ok) return res;
  refresh(contactId);
  return { ok: true };
}

export async function deleteWhatsAppDataAction(contactId: number): Promise<WhatsAppActionResult> {
  await requireAuth();
  const res = deleteWhatsAppData(contactId);
  if (!res.ok) return res;
  refresh(contactId);
  return {
    ok: true,
    message: `Removed ${res.messages} WhatsApp message${res.messages === 1 ? "" : "s"} and ${res.timelineRows} timeline row${res.timelineRows === 1 ? "" : "s"}.`,
  };
}
