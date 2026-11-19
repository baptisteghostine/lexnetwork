import "server-only";

import { z } from "zod";

import { WA_BODY_MAX, WA_KINDS } from "@/lib/whatsapp/chat";
import { readBodyLimited } from "@/server/agent/http";
import { collectorDeliver, collectorTokenMatches, collectorWants } from "@/server/whatsapp-core";

// The laptop collector's two calls (SPEC §15), as functions of a Request
// so they can be tested without a server. The collector is a program on
// the owner's Windows laptop; it has not been built yet — this is the
// contract it will be built to.
//
//   GET  → what to read: the numbers whose sync is on, with date ranges.
//   POST → the messages of those chats, and nothing else.
//
// Auth is a bearer token the owner copies to the laptop once, compared in
// constant time. Until a token is created the endpoint answers nobody.

const DELIVERY_BODY_MAX = 4 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function authorized(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/i.exec(header);
  return collectorTokenMatches(match ? match[1].trim() : null);
}

export function handleCollectorWants(req: Request): Response {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  // Numbers and dates only: no name, no contact id, nothing about anyone
  // whose sync is off.
  return json({ ok: true, serverTime: Date.now(), wants: collectorWants() });
}

const message = z.strictObject({
  id: z.string().min(1).max(200),
  at: z.number().int().positive(),
  fromMe: z.boolean(),
  kind: z.enum(WA_KINDS),
  // No field for media: a photo arrives as kind "media" and no text.
  text: z.string().max(WA_BODY_MAX * 2).nullable().optional(),
});

const delivery = z.strictObject({
  chats: z
    .array(
      z.strictObject({
        // Checked as a string here and as a linked, enabled number in the core.
        waId: z.string().min(1).max(64),
        coveredFrom: z.number().int().positive(),
        coveredTo: z.number().int().positive(),
        messages: z.array(message).max(2000),
      })
    )
    .max(200),
});

export async function handleCollectorDelivery(req: Request): Promise<Response> {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const raw = await readBodyLimited(req, DELIVERY_BODY_MAX);
  if (raw === null) return json({ error: "The delivery is too large. Send fewer messages per request." }, 413);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return json({ error: "The body is not JSON." }, 400);
  }
  const parsed = delivery.safeParse(parsedJson);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return json({ error: `Invalid delivery — ${issue.path.join(".")}: ${issue.message}` }, 400);
  }
  const result = collectorDeliver(
    parsed.data.chats.map((chat) => ({
      // Anything that is not a plain number (a group id, a newsletter) is
      // passed through as it is and refused by the core with the rest.
      waId: chat.waId,
      coveredFrom: chat.coveredFrom,
      coveredTo: chat.coveredTo,
      messages: chat.messages.map((m) => ({
        key: m.id,
        direction: m.fromMe ? ("outbound" as const) : ("inbound" as const),
        sentAt: m.at,
        kind: m.kind,
        body: m.kind === "text" ? (m.text ?? null) : null,
      })),
    }))
  );
  // 200 even when chats were refused: the accepted ones are stored, and
  // the count tells the collector its list was stale. The refusal is also
  // on Rolo's sync log as a failure.
  return json({ ok: true, ...result });
}
