import { createHash } from "node:crypto";

import { desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { syncRuns } from "@/db/schema";
import {
  parseConnectionsResponse,
  voyagerToConnection,
  type VoyagerConnection,
} from "@/lib/linkedin/voyager";
import { executeLinkedInRows } from "@/server/linkedin-import";
import { extensionTokenMatches } from "@/server/sync/extension-pairing";
import { enrichProgress } from "@/server/sync/linkedin-enrich";

// Receiving end of the Rolo browser extension (SPEC §9c).
//
// The extension pages LinkedIn's Voyager API from inside the owner's real
// Chrome — genuine TLS fingerprint, genuine same-origin request, cookies
// the browser manages — and posts each raw page here. Parsing uses the
// same structural parser as the cookie sync, and the rows land in the
// same import core as the ZIP: one identity ladder, one set of
// provenance rules, one job-change detector.
//
// Auth is a bearer token from Settings, not the session cookie: the post
// arrives cross-origin from the extension, where a SameSite=Lax cookie
// would never be sent.

type Session = {
  connections: Map<string, VoyagerConnection>;
  startedAt: number;
  pages: number;
};

// In-process only, and deliberately so: a sync is a couple of minutes of
// one person's browser talking to their own laptop. If the server
// restarts mid-run the session is gone and the final POST says so —
// re-running costs one click, whereas persisting half-finished scrapes
// would be state nobody wants to reason about.
const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 30 * 60 * 1000;

function sweep(now: number): void {
  for (const [id, s] of sessions) {
    if (now - s.startedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function bearer(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

/**
 * What the popup shows before anyone clicks anything: is the token good,
 * when did the last sync land and what did it change, and how far along
 * the location trickle is. A 401 here is how the popup learns a rotated
 * token, instead of the owner finding out three pages into a sync.
 */
export async function GET(req: NextRequest) {
  if (!extensionTokenMatches(bearer(req))) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: CORS }
    );
  }
  const last = db
    .select({
      status: syncRuns.status,
      statsJson: syncRuns.statsJson,
      error: syncRuns.error,
      startedAt: syncRuns.startedAt,
      finishedAt: syncRuns.finishedAt,
    })
    .from(syncRuns)
    .where(eq(syncRuns.kind, "linkedin_voyager_sync"))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1)
    .get();
  let stats: unknown = null;
  try {
    stats = last?.statsJson ? JSON.parse(last.statsJson) : null;
  } catch {
    stats = null; // a corrupt stats blob shouldn't take the popup down
  }
  return NextResponse.json(
    {
      ok: true,
      lastSync: last
        ? {
            status: last.status,
            startedAt: last.startedAt,
            finishedAt: last.finishedAt,
            error: last.error,
            stats,
          }
        : null,
      enrich: enrichProgress(Date.now()),
    },
    { headers: CORS }
  );
}

export async function POST(req: NextRequest) {
  if (!extensionTokenMatches(bearer(req))) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: CORS }
    );
  }

  const body = (await req.json().catch(() => null)) as {
    sessionId?: string;
    page?: unknown;
    done?: boolean;
  } | null;
  const sessionId = body?.sessionId;
  if (!body || typeof sessionId !== "string" || sessionId.length < 8) {
    return NextResponse.json(
      { error: "sessionId required" },
      { status: 400, headers: CORS }
    );
  }

  const now = Date.now();
  sweep(now);
  let session = sessions.get(sessionId);
  if (!session) {
    session = { connections: new Map(), startedAt: now, pages: 0 };
    sessions.set(sessionId, session);
  }

  // A page of raw Voyager JSON — parsed here so the extension stays dumb
  // and the tested parser stays the single source of truth.
  if (body.page !== undefined) {
    const parsed = parseConnectionsResponse(body.page);
    for (const c of parsed.connections) {
      session.connections.set(c.publicIdentifier, c);
    }
    session.pages += 1;
    return NextResponse.json(
      {
        ok: true,
        // `parsed` is what this page held; `received` is the running
        // unique total. The extension needs both to tell "end of list"
        // from "the same window served again".
        parsed: parsed.connections.length,
        received: session.connections.size,
        total: parsed.total,
      },
      { headers: CORS }
    );
  }

  if (body.done !== true) {
    return NextResponse.json(
      { error: "nothing to do" },
      { status: 400, headers: CORS }
    );
  }

  sessions.delete(sessionId);
  const connections = [...session.connections.values()];
  // Fail loud, exactly like the cookie sync: an empty result means the
  // response shape drifted or the session died — never "you have no
  // connections", which would look like a successful no-op.
  if (connections.length === 0) {
    return NextResponse.json(
      {
        error:
          "No connections were parsed from the pages the extension sent — LinkedIn's response shape may have changed (see src/lib/linkedin/voyager.ts).",
      },
      { status: 422, headers: CORS }
    );
  }

  const { runId, report } = executeLinkedInRows({
    connections: connections.map(voyagerToConnection),
    // The extension reads the connection list only; the ZIP remains the
    // way conversations enter the timeline.
    messages: [],
    ownerName: null,
    runKind: "linkedin_voyager_sync",
    fileName: `extension-sync-${new Date(session.startedAt).toISOString().slice(0, 10)}`,
    fileSha256: createHash("sha256")
      .update([...session.connections.keys()].sort().join("\n"))
      .digest("hex"),
  });

  return NextResponse.json(
    {
      runId,
      pages: session.pages,
      connections: connections.length,
      stats: report.stats,
    },
    { headers: CORS }
  );
}
