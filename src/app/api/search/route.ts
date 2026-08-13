import { desc, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { contactEmails, contacts } from "@/db/schema";
import { isAuthenticated } from "@/lib/auth";

// Command-palette contact search: name, company, or email substring.
// FTS5 (Phase 6) will replace the LIKE scans; at personal scale this is
// already instant.
export async function GET(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ results: [] });
  const pattern = `%${q.replaceAll(/[%_\\]/g, (c) => `\\${c}`)}%`;

  const rows = db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      company: contacts.company,
      title: contacts.title,
      photoPath: contacts.photoPath,
      starred: contacts.starred,
    })
    .from(contacts)
    .where(
      sql`${contacts.archivedAt} IS NULL AND (
        ${contacts.displayName} LIKE ${pattern} ESCAPE '\\'
        OR ${contacts.company} LIKE ${pattern} ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM ${contactEmails}
          WHERE ${contactEmails.contactId} = ${contacts.id}
          AND ${contactEmails.email} LIKE ${pattern} ESCAPE '\\'
        )
      )`
    )
    .orderBy(desc(contacts.starred), contacts.displayName)
    .limit(10)
    .all();

  return NextResponse.json({
    results: rows.map((c) => ({
      id: c.id,
      name: c.displayName,
      detail: [c.title, c.company].filter(Boolean).join(" · "),
      hasPhoto: c.photoPath !== null,
      starred: c.starred,
    })),
  });
}
