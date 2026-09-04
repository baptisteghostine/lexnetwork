import { NextRequest, NextResponse } from "next/server";

import { driftWarning, type EnrichResult } from "@/lib/linkedin/enrich";
import {
  applyEnrichResults,
  contactIdsFor,
  enrichEnabled,
  takeEnrichBatch,
} from "@/server/sync/linkedin-enrich";
import {
  EXTENSION_CORS as CORS,
  extensionOptions,
  extensionUnauthorized,
} from "@/server/sync/extension-http";

// Profile-location enrichment, extension side (SPEC §9d).
//
// Two verbs on one route. "next" hands out a small batch of profiles worth
// looking up; "result" takes back what the extension found. Splitting them
// is what makes the trickle safe to interrupt: the extension can stop at
// any point — tab closed, LinkedIn refused, laptop shut — and the only
// cost is that a few profiles go unstamped and come round again.
//
// Auth is the same bearer token as the connection sync, for the same
// reason: this arrives cross-origin from a chrome-extension:// page, where
// Rolo's SameSite=Lax session cookie would never be sent.

const MAX_BATCH = 25;

export async function OPTIONS() {
  return extensionOptions();
}

export async function POST(req: NextRequest) {
  const denied = extensionUnauthorized(req);
  if (denied) return denied;

  if (!enrichEnabled()) {
    return NextResponse.json(
      {
        error:
          "Location enrichment is off. Turn it on in Settings → LinkedIn before running it.",
      },
      { status: 409, headers: CORS }
    );
  }

  const body = (await req.json().catch(() => null)) as {
    action?: unknown;
    batchSize?: unknown;
    results?: unknown;
  } | null;
  const now = Date.now();

  if (body?.action === "next") {
    const requested =
      typeof body.batchSize === "number" && Number.isFinite(body.batchSize)
        ? Math.floor(body.batchSize)
        : 10;
    const batch = takeEnrichBatch(now, Math.max(1, Math.min(MAX_BATCH, requested)));
    return NextResponse.json(batch, { headers: CORS });
  }

  if (body?.action === "result") {
    if (!Array.isArray(body.results)) {
      return NextResponse.json(
        { error: "results must be an array" },
        { status: 400, headers: CORS }
      );
    }
    const results: EnrichResult[] = [];
    for (const raw of body.results) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as { publicIdentifier?: unknown; location?: unknown };
      if (typeof r.publicIdentifier !== "string") continue;
      const identifier = r.publicIdentifier.trim().toLowerCase();
      if (identifier === "") continue;
      results.push({
        publicIdentifier: identifier,
        location:
          typeof r.location === "string" && r.location.trim() !== ""
            ? r.location.trim()
            : null,
      });
    }
    if (results.length === 0) {
      return NextResponse.json(
        { error: "no usable results in the batch" },
        { status: 400, headers: CORS }
      );
    }

    const ids = contactIdsFor(results.map((r) => r.publicIdentifier));
    const applied = applyEnrichResults(results, ids, now);
    return NextResponse.json(
      {
        ...applied,
        // Surfaced rather than swallowed: an all-placeless round is much
        // more likely to be a shape change than a run of private profiles.
        warning: driftWarning(applied.summary),
      },
      { headers: CORS }
    );
  }

  return NextResponse.json(
    { error: "action must be 'next' or 'result'" },
    { status: 400, headers: CORS }
  );
}
