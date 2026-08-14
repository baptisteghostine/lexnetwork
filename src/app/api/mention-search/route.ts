import { sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { contacts, groups } from "@/db/schema";
import { isAuthenticated } from "@/lib/auth";

// Autocomplete source for @contact / #group mentions in the note editor.
export async function GET(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const kind = req.nextUrl.searchParams.get("kind");
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  // Escape LIKE wildcards in user input; the ESCAPE clause below is what
  // makes the backslashes meaningful to SQLite.
  const pattern = `%${q.replaceAll(/[%_\\]/g, (c) => `\\${c}`)}%`;

  if (kind === "group") {
    const rows = db
      .select({ id: groups.id, name: groups.name, emoji: groups.emoji })
      .from(groups)
      .where(sql`${groups.name} LIKE ${pattern} ESCAPE '\\'`)
      .limit(8)
      .all();
    return NextResponse.json({
      results: rows.map((g) => ({
        id: g.id,
        label: g.name,
        detail: g.emoji ?? "",
      })),
    });
  }

  const rows = db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      company: contacts.company,
    })
    .from(contacts)
    // Archived contacts are hidden from every default surface (SPEC §1) —
    // mention autocomplete was the one query that still returned them.
    .where(
      sql`${contacts.displayName} LIKE ${pattern} ESCAPE '\\' AND ${contacts.archivedAt} IS NULL`
    )
    .orderBy(contacts.displayName)
    .limit(8)
    .all();
  return NextResponse.json({
    results: rows.map((c) => ({
      id: c.id,
      label: c.displayName,
      detail: c.company ?? "",
    })),
  });
}
