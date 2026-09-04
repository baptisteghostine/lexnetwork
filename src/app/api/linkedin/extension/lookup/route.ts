import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { publicIdentifierFromPath } from "@/lib/linkedin/capture";
import {
  extensionJson,
  extensionOptions,
  extensionUnauthorized,
} from "@/server/sync/extension-http";
import { contactIdsFor } from "@/server/sync/linkedin-enrich";

// "Is this person in Rolo?" for the profile the owner is looking at
// (SPEC §9c capture). Read-only; the popup asks once per profile page.

export async function OPTIONS() {
  return extensionOptions();
}

export async function GET(req: NextRequest) {
  const denied = extensionUnauthorized(req);
  if (denied) return denied;
  const raw = req.nextUrl.searchParams.get("id") ?? "";
  const id = publicIdentifierFromPath(`/in/${raw}/`);
  if (!id) return extensionJson({ error: "id required" }, 400);

  const contactId = contactIdsFor([id]).get(id);
  if (contactId === undefined) return extensionJson({ ok: true, found: false, id });
  const c = db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      title: contacts.title,
      company: contacts.company,
      starred: contacts.starred,
      archivedAt: contacts.archivedAt,
      cadenceDays: contacts.cadenceDays,
      lastInteractionAt: contacts.lastInteractionAt,
      nextTouchAt: contacts.nextTouchAt,
      createdAt: contacts.createdAt,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .get();
  if (!c) return extensionJson({ ok: true, found: false, id });
  return extensionJson({ ok: true, found: true, id, contact: c });
}
