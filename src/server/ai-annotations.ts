import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { aiAnnotations } from "@/db/schema";

// AI annotations (SPEC §11, 2026-09-26): model-written sidecars keyed by
// the row they describe. One row per (kind, subject); regenerating
// replaces it. Nothing here touches the described row itself — the
// "AI never writes user data directly" rule holds by construction.

export type AnnotationKind = "change_triage" | "contact_profile" | "meeting_followup";

export function upsertAnnotation(
  kind: AnnotationKind,
  subjectId: number,
  payload: unknown,
  model: string,
  aiCallId: number | null
): void {
  const now = Date.now();
  db.insert(aiAnnotations)
    .values({
      kind,
      subjectId,
      payloadJson: JSON.stringify(payload),
      model,
      aiCallId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [aiAnnotations.kind, aiAnnotations.subjectId],
      set: {
        payloadJson: JSON.stringify(payload),
        model,
        aiCallId,
        updatedAt: now,
      },
    })
    .run();
}

export type Annotation<T> = { payload: T; model: string; updatedAt: number };

export function readAnnotation<T>(kind: AnnotationKind, subjectId: number): Annotation<T> | null {
  const row = db
    .select()
    .from(aiAnnotations)
    .where(and(eq(aiAnnotations.kind, kind), eq(aiAnnotations.subjectId, subjectId)))
    .get();
  if (!row) return null;
  try {
    return { payload: JSON.parse(row.payloadJson) as T, model: row.model, updatedAt: row.updatedAt };
  } catch {
    return null;
  }
}

export function readAnnotations<T>(
  kind: AnnotationKind,
  subjectIds: number[]
): Map<number, Annotation<T>> {
  const out = new Map<number, Annotation<T>>();
  if (subjectIds.length === 0) return out;
  const rows = db
    .select()
    .from(aiAnnotations)
    .where(and(eq(aiAnnotations.kind, kind), inArray(aiAnnotations.subjectId, subjectIds)))
    .all();
  for (const row of rows) {
    try {
      out.set(row.subjectId, {
        payload: JSON.parse(row.payloadJson) as T,
        model: row.model,
        updatedAt: row.updatedAt,
      });
    } catch {
      // An unreadable payload is treated as absent — it will be rebuilt.
    }
  }
  return out;
}

export function deleteAnnotation(kind: AnnotationKind, subjectId: number): void {
  db.delete(aiAnnotations)
    .where(and(eq(aiAnnotations.kind, kind), eq(aiAnnotations.subjectId, subjectId)))
    .run();
}
