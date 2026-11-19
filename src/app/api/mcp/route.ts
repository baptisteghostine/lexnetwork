import { handleMcp } from "@/server/agent/http";

// The agent connector's MCP endpoint (SPEC §14). Bearer-token gated; the
// logic lives in src/server/agent/http.ts.
export const dynamic = "force-dynamic";

export const POST = handleMcp;
// The transport answers GET and DELETE itself (405: this endpoint keeps no
// session), but only after the same token check as a POST.
export const GET = handleMcp;
export const DELETE = handleMcp;
export const OPTIONS = handleMcp;
