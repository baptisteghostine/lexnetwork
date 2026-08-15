import { KeepInTouchBoard } from "@/components/keep-in-touch-board";
import { requireAuth } from "@/lib/auth";
import { readKeepInTouchBoard } from "@/server/keep-in-touch";

export const dynamic = "force-dynamic";

export default async function KeepInTouchPage() {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const board = await readKeepInTouchBoard();
  return <KeepInTouchBoard board={board} />;
}
