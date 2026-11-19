import { handleToken } from "@/server/agent/http";

// OAuth token endpoint for the agent connector (SPEC §14).
export const dynamic = "force-dynamic";

export const POST = handleToken;
export const OPTIONS = handleToken;
