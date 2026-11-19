import { NextRequest } from "next/server";

import {
  capturedProfileToConnection,
  parseCapturedProfile,
} from "@/lib/linkedin/capture";
import { capturedSectionsSchema, type CapturedSections } from "@/lib/linkedin/profile-sections";
import { executeLinkedInRows } from "@/server/linkedin-import";
import { applyProfileSections } from "@/server/linkedin-profile";
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
  const body = (await req.json().catch(() => null)) as { profile?: unknown; sections?: unknown } | null;
  const profile = parseCapturedProfile(body?.profile);
  if (!profile) return extensionJson({ error: "profile required" }, 400);
  // Experience, education and About, as lines of text (SPEC §9c career
  // history). Optional: an older extension sends none, and the capture
  // works as it always did. Present but malformed is refused rather than
  // half-read.
  let sections: CapturedSections | null = null;
  if (body?.sections !== undefined && body.sections !== null) {
    const parsed = capturedSectionsSchema.safeParse(body.sections);
    if (!parsed.success) return extensionJson({ error: "The page's career sections could not be read — reload the extension." }, 400);
    sections = parsed.data;
  }
  const row = capturedProfileToConnection(profile);
  if (!row && sections) {
    // A "show all experience" page carries the career and not the name.
    // For someone already in Rolo that is all it needs to carry.
    const existing = contactIdsFor([profile.publicIdentifier]).get(profile.publicIdentifier) ?? null;
    if (existing !== null) {
      return extensionJson({ ok: true, contactId: existing, created: false, updated: false, conflicts: 0, jobChanges: 0, career: applyProfileSections(existing, sections) });
    }
  }
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
  const career = sections && contactId !== null ? applyProfileSections(contactId, sections) : null;
  // A capture is exactly the moment a "what I know" card goes stale
  // (SPEC §11); the job picks it up within a tick. Lazy: the scheduler
  // imports the import core this route uses.
  // Keyed to the minute: a run of captures queues one job, not one each.
  const runAt = Date.now();
  void import("@/jobs/scheduler")
    .then((m) =>
      m.enqueueJob({ kind: "ai_enrich", runAt, dedupeKey: `ai_enrich:capture:${Math.floor(runAt / 60_000)}` })
    )
    .catch((err) => console.error("[rolo-capture] enrich enqueue failed:", err));
  return extensionJson({
    ok: true,
    runId,
    contactId,
    created: report.stats.new > 0,
    updated: report.stats.updated > 0,
    conflicts: report.conflicts.length,
    jobChanges: report.jobChanges.length,
    // What was read off the page and what it changed, so the popup can say
    // so — and so a layout change that reads nothing is visible at once.
    ...(career ? { career } : {}),
  });
}
