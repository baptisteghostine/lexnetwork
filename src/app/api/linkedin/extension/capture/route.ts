import { NextRequest } from "next/server";

import {
  capturedProfileToConnection,
  parseCapturedProfile,
} from "@/lib/linkedin/capture";
import { executeLinkedInRows } from "@/server/linkedin-import";
import {
  extensionJson,
  extensionOptions,
  extensionUnauthorized,
} from "@/server/sync/extension-http";
import { contactIdsFor } from "@/server/sync/linkedin-enrich";

// "Add to Rolo" from a profile page (SPEC §9c capture). One row through
// the same import core as the ZIP and the connection sync — the identity
// ladder finds an existing contact by profile URL, provenance rules keep
// an owner-typed title from being overwritten, and a headline that moved
// is a job change like any other.

export async function OPTIONS() {
  return extensionOptions();
}

export async function POST(req: NextRequest) {
  const denied = extensionUnauthorized(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { profile?: unknown } | null;
  const profile = parseCapturedProfile(body?.profile);
  if (!profile) return extensionJson({ error: "profile required" }, 400);
  const row = capturedProfileToConnection(profile);
  if (!row) {
    return extensionJson(
      { error: "No name could be read from this page — reload it and try again." },
      422
    );
  }
  const { runId, report } = executeLinkedInRows({
    connections: [row],
    messages: [],
    ownerName: null,
    runKind: "linkedin_profile_capture",
    fileName: `capture-${profile.publicIdentifier}`,
  });
  if (report.stats.errors > 0) {
    return extensionJson({ error: "Rolo couldn't apply the profile — see the import report." }, 500);
  }
  const contactId = contactIdsFor([profile.publicIdentifier]).get(profile.publicIdentifier) ?? null;
  return extensionJson({
    ok: true,
    runId,
    contactId,
    created: report.stats.new > 0,
    updated: report.stats.updated > 0,
    conflicts: report.conflicts.length,
    jobChanges: report.jobChanges.length,
  });
}
