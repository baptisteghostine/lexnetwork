import { NextRequest, NextResponse } from "next/server";

import { isAuthenticated } from "@/lib/auth";
import { searchAll } from "@/server/search";

// Command-palette search: trigram FTS + Jaro-Winkler/nickname re-rank for
// contacts, word FTS over note bodies. `results` keeps the contact shape
// earlier consumers (reminder form) already use.
export async function GET(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ results: [], notes: [] });
  // SPEC §1: archived contacts are findable only with the toggle on.
  const includeArchived = req.nextUrl.searchParams.get("archived") === "1";
  const { contacts, notes } = searchAll(q, { includeArchived });
  return NextResponse.json({ results: contacts, notes });
}
