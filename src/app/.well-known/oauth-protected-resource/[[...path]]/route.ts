import { preflight, protectedResourceResponse } from "@/server/agent/http";

// RFC 9728 protected-resource metadata for the agent connector (SPEC §14).
// Served at the bare path and with the MCP path appended — clients probe
// both. The optional catch-all answers either.
export const dynamic = "force-dynamic";

export const GET = protectedResourceResponse;
export const OPTIONS = preflight;
