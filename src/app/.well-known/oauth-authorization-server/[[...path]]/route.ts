import { authorizationServerResponse, preflight } from "@/server/agent/http";

// RFC 8414 authorization-server metadata for the agent connector (SPEC §14).
export const dynamic = "force-dynamic";

export const GET = authorizationServerResponse;
export const OPTIONS = preflight;
