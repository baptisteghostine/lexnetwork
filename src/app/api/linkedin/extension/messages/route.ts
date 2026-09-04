import { NextRequest } from "next/server";

import { recomputeContact } from "@/lib/cadence/recompute";
import {
  capturedConversationToMessages,
  capturedProfileToConnection,
  parseCapturedConversation,
  parseCapturedProfile,
} from "@/lib/linkedin/capture";
import {
  executeLinkedInRows,
  insertLinkedInMessages,
  matchConversationCounterpart,
} from "@/server/linkedin-import";
import {
  extensionJson,
  extensionOptions,
  extensionUnauthorized,
} from "@/server/sync/extension-http";
import { contactIdsFor } from "@/server/sync/linkedin-enrich";

// "Log this conversation" from the messaging view (SPEC §9c messaging,
// owner request 2026-09-04). The extension reads the thread the owner
// has open — no request to LinkedIn — and posts dates, direction, and a
// snippet-bounded first line. Rows go through insertLinkedInMessages with
// the same conversation+timestamp key the ZIP uses, so a later ZIP import
// of the same thread is a no-op on these rows, not a duplicate.
//
// The counterpart is matched like the ZIP's messages.csv: profile URL,
// then a unique name among LinkedIn-sourced contacts. Someone not in
// Rolo yet is created from the thread header — the owner clicked "log
// this conversation" about a person they are messaging, which is as
// deliberate as it gets.

export async function OPTIONS() {
  return extensionOptions();
}

export async function POST(req: NextRequest) {
  const denied = extensionUnauthorized(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { conversation?: unknown } | null;
  const convo = parseCapturedConversation(body?.conversation);
  if (!convo) return extensionJson({ error: "conversation required (with at least one message)" }, 400);

  const messages = capturedConversationToMessages(convo);
  const profileUrl = messages[0]?.counterpartProfileUrl ?? null;
  let contactId = matchConversationCounterpart(convo.counterpartName, profileUrl);
  let created = false;

  if (contactId === null) {
    const identifier = convo.counterpartPublicIdentifier;
    if (!identifier) {
      return extensionJson(
        {
          error: `${convo.counterpartName} isn't in Rolo and the thread carries no profile link to add them by — open their profile and Add to Rolo first.`,
          unmatched: true,
        },
        422
      );
    }
    const profile = parseCapturedProfile({ publicIdentifier: identifier, fullName: convo.counterpartName });
    const row = profile ? capturedProfileToConnection(profile) : null;
    if (!row) return extensionJson({ error: "Couldn't build a contact from the thread header." }, 422);
    const { report } = executeLinkedInRows({
      connections: [row],
      messages: [],
      ownerName: null,
      runKind: "linkedin_profile_capture",
      fileName: `capture-${identifier}`,
    });
    if (report.stats.errors > 0) return extensionJson({ error: "Rolo couldn't create the contact." }, 500);
    contactId = contactIdsFor([identifier.toLowerCase()]).get(identifier.toLowerCase()) ?? null;
    if (contactId === null) return extensionJson({ error: "Contact created but not found again — try once more." }, 500);
    created = report.stats.new > 0;
  }

  const inserted = insertLinkedInMessages(
    contactId,
    convo.conversationId,
    messages.map((m) => ({ direction: m.direction, occurredAt: m.occurredAt, snippet: m.snippet })),
    null
  );
  recomputeContact(contactId);
  return extensionJson({ ok: true, contactId, created, inserted, total: messages.length });
}
