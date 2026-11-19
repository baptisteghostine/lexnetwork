import { handleRegister } from "@/server/agent/http";

// OAuth dynamic client registration for the agent connector (SPEC §14).
export const dynamic = "force-dynamic";

export const POST = handleRegister;
export const OPTIONS = handleRegister;
