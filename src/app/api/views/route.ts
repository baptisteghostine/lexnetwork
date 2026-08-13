import { asc } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { views } from "@/db/schema";
import { isAuthenticated } from "@/lib/auth";

// Palette "run a saved view" source.
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rows = db
    .select({ id: views.id, name: views.name })
    .from(views)
    .orderBy(asc(views.sortOrder), asc(views.name))
    .all();
  return NextResponse.json({ views: rows });
}
