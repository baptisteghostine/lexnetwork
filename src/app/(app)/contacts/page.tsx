import Link from "next/link";
import { eq } from "drizzle-orm";

import { ContactsList } from "@/components/contacts-list";
import { FilterBar } from "@/components/filter-bar";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { contactTags, tags as tagsTable, views } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { decodeFilterParam } from "@/lib/filters/encode";
import {
  emptyFilterSet,
  parseFilterSet,
  type FilterSet,
  type SortSpec,
} from "@/lib/filters/types";
import { now as currentTime } from "@/lib/time";
import { listGroups, listTags } from "@/server/queries";
import { runFilter } from "@/server/views";

export const dynamic = "force-dynamic";

// Render cap — a real LinkedIn import lands thousands of contacts, and an
// unbounded server-rendered table makes the page unusable long before the
// Phase 11 virtualization pass. The header still shows the true total.
const PAGE_LIMIT = 500;

const SORTS: { key: string; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "company", label: "Company" },
  { key: "recent", label: "Recently added" },
];

function sortSpec(param: string): SortSpec {
  if (param === "company") return { key: "company", dir: "asc" };
  if (param === "recent") return { key: "recent", dir: "desc" };
  return { key: "name", dir: "asc" };
}

export default async function ContactsPage({
  searchParams,
}: PageProps<"/contacts">) {
  // Layouts and pages render in parallel — the layout's requireAuth() alone
  // does not stop this page's data from entering the response stream, so
  // every protected page guards itself.
  await requireAuth();
  const params = await searchParams;
  const sortParam = ["name", "company", "recent"].includes(String(params.sort))
    ? String(params.sort)
    : "name";

  // Filter source of truth: saved view > ?f= > legacy archived toggle.
  let filter: FilterSet | null = null;
  let activeView: { id: number; name: string } | null = null;
  const viewId = Number(params.view);
  if (Number.isInteger(viewId) && viewId > 0) {
    const v = db.select().from(views).where(eq(views.id, viewId)).get();
    if (v) {
      filter = parseFilterSet(v.filterJson);
      activeView = { id: v.id, name: v.name };
    }
  }
  if (!filter && typeof params.f === "string") {
    filter = decodeFilterParam(params.f);
  }
  if (!filter) {
    filter = emptyFilterSet();
    if (params.archived === "1") {
      filter.clauses.push({ dim: "archived", value: true });
    }
  }
  const archivedView = filter.clauses.some(
    (c) => c.dim === "archived" && c.value
  );

  const nowMs = currentTime();
  const { contacts: rows, total, warnings } = await runFilter(filter, {
    now: nowMs,
    sort: sortSpec(sortParam),
    limit: PAGE_LIMIT,
  });

  const allTags = listTags();
  const allGroups = listGroups();
  const rowIds = new Set(rows.map((r) => r.id));
  const tagRows = db
    .select({
      contactId: contactTags.contactId,
      id: tagsTable.id,
      name: tagsTable.name,
      color: tagsTable.color,
    })
    .from(contactTags)
    .innerJoin(tagsTable, eq(tagsTable.id, contactTags.tagId))
    .all()
    .filter((t) => rowIds.has(t.contactId));
  const tagsByContact = new Map<
    number,
    { id: number; name: string; color: string }[]
  >();
  for (const t of tagRows) {
    const list = tagsByContact.get(t.contactId) ?? [];
    list.push({ id: t.id, name: t.name, color: t.color });
    tagsByContact.set(t.contactId, list);
  }

  return (
    <div>
      <header className="flex items-center justify-between border-b border-border px-5 py-2.5">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold">
            {activeView?.name ?? (archivedView ? "Archived" : "Contacts")}
          </h1>
          <span className="text-xs text-muted-foreground">{total}</span>
        </div>
        <div className="flex items-center gap-1">
          {SORTS.map((s) => (
            <Link
              key={s.key}
              href={`/contacts?sort=${s.key}${typeof params.f === "string" ? `&f=${params.f}` : ""}${activeView ? `&view=${activeView.id}` : ""}`}
              className={`rounded px-2 py-1 text-xs ${
                sortParam === s.key
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {s.label}
            </Link>
          ))}
          <Link
            href={archivedView ? "/contacts" : "/contacts?archived=1"}
            className="ml-2 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {archivedView ? "Active" : "Archived"}
          </Link>
          <Button asChild size="sm" className="ml-3">
            <Link href="/contacts/new">New contact</Link>
          </Button>
        </div>
      </header>

      <FilterBar
        filter={filter}
        sortParam={sortParam === "name" ? "" : sortParam}
        warnings={warnings}
        allTags={allTags.map((t) => ({ id: t.id, name: t.name }))}
        allGroups={allGroups.map((g) => ({ id: g.id, name: g.name }))}
        activeView={activeView}
      />

      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-xs text-muted-foreground">
          {filter.clauses.length > 0
            ? "No contacts match this filter."
            : archivedView
              ? "Nothing archived."
              : "No contacts yet — create one, or use Imports in the sidebar."}
        </p>
      ) : (
        <>
          {total > rows.length && (
            <p className="border-b border-border px-5 py-1.5 text-xs text-muted-foreground">
              Showing the first {rows.length} of {total} — narrow with filters
              or search (⌘K) to see the rest.
            </p>
          )}
          <ContactsList
            archivedView={archivedView}
            allTags={allTags}
            rows={rows.map((c) => ({
              id: c.id,
              displayName: c.displayName,
              title: c.title,
              company: c.company,
              starred: c.starred,
              cadenceDays: c.cadenceDays,
              hasPhoto: c.photoPath !== null,
              overdue: c.nextTouchAt !== null && c.nextTouchAt <= nowMs,
              tags: tagsByContact.get(c.id) ?? [],
            }))}
          />
        </>
      )}
    </div>
  );
}
