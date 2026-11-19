"use server";

import { revalidatePath } from "next/cache";

import { requireAuth } from "@/lib/auth";
import { isEmailPattern } from "@/lib/outreach/email-pattern";
import { acceptGuess, confirmGuess, dismissGuess } from "@/server/email-guess-core";
import { setFirmEmailFormat, setFirmTier } from "@/server/firms-core";

// The owner's side of firms and address guesses (SPEC §17). Every export
// is an endpoint, so every one starts with requireAuth; the rules are in
// firms-core and email-guess-core.

export type FirmActionResult = { ok: true; message?: string } | { ok: false; error: string };

function refresh(contactId?: number): void {
  revalidatePath("/outreach");
  revalidatePath("/outreach/firms");
  revalidatePath("/contacts");
  if (contactId) revalidatePath(`/contacts/${contactId}`);
}

/** Put the address Rolo suggested on the contact. Only the owner can. */
export async function acceptGuessAction(contactId: number, email: string): Promise<FirmActionResult> {
  await requireAuth();
  if (!Number.isInteger(contactId)) return { ok: false, error: "Unknown contact." };
  const res = acceptGuess(contactId, String(email ?? ""));
  if (!res.ok) return res;
  refresh(contactId);
  return { ok: true, message: `${res.email} is now on the contact, marked as a guess.` };
}

export async function dismissGuessAction(contactId: number, email: string): Promise<FirmActionResult> {
  await requireAuth();
  if (!Number.isInteger(contactId)) return { ok: false, error: "Unknown contact." };
  const res = dismissGuess(contactId, String(email ?? ""));
  if (!res.ok) return res;
  refresh(contactId);
  return { ok: true };
}

export async function confirmGuessAction(contactId: number, email: string): Promise<FirmActionResult> {
  await requireAuth();
  if (!Number.isInteger(contactId)) return { ok: false, error: "Unknown contact." };
  const res = confirmGuess(contactId, String(email ?? ""));
  if (!res.ok) return res;
  refresh(contactId);
  return { ok: true };
}

/** Set a firm's tier, or clear it with an empty name. */
export async function setFirmTierAction(company: string, tier: string): Promise<FirmActionResult> {
  await requireAuth();
  const name = String(tier ?? "").trim();
  const res = setFirmTier({ company: String(company ?? ""), tier: name ? name : null, source: "user" });
  if (!res.ok) return { ok: false, error: res.error };
  refresh();
  return { ok: true, message: res.after.tier ? `${res.name}: ${res.after.tier}.` : `${res.name} has no tier now.` };
}

/** Set how a firm forms its addresses, or forget it with an empty domain. */
export async function setFirmFormatAction(company: string, domain: string, pattern: string): Promise<FirmActionResult> {
  await requireAuth();
  const host = String(domain ?? "").trim();
  if (host && !isEmailPattern(pattern)) return { ok: false, error: "Choose how the part before the @ is built." };
  const res = setFirmEmailFormat({ company: String(company ?? ""), domain: host ? host : null, pattern: isEmailPattern(pattern) ? pattern : null, source: "user" });
  if (!res.ok) return { ok: false, error: res.error };
  refresh();
  return { ok: true, message: res.after.emailDomain ? `Saved for ${res.name}.` : `Forgotten for ${res.name}.` };
}
