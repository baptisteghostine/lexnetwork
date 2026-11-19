import { handleCollectorDelivery, handleCollectorWants } from "@/server/whatsapp-collector";

// The laptop collector's endpoint (SPEC §15). Token-gated; see
// src/server/whatsapp-collector.ts for the contract.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handleCollectorWants(req);
}

export async function POST(req: Request) {
  return handleCollectorDelivery(req);
}
