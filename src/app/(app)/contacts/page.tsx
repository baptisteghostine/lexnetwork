import Link from "next/link";
import { Star } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireAuth } from "@/lib/auth";
import { listContacts, type ContactSort } from "@/server/queries";

export const dynamic = "force-dynamic";

const SORTS: { key: ContactSort; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "company", label: "Company" },
  { key: "recent", label: "Recently added" },
];

export default async function ContactsPage({
  searchParams,
}: PageProps<"/contacts">) {
  // Layouts and pages render in parallel — the layout's requireAuth() alone
  // does not stop this page's data from entering the response stream, so
  // every protected page guards itself.
  await requireAuth();
  const params = await searchParams;
  const sort = (
    ["name", "company", "recent"].includes(String(params.sort))
      ? params.sort
      : "name"
  ) as ContactSort;
  const archived = params.archived === "1";
  const rows = listContacts({ sort, archived });

  return (
    <div>
      <header className="flex items-center justify-between border-b border-border px-5 py-2.5">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold">
            {archived ? "Archived" : "Contacts"}
          </h1>
          <span className="text-xs text-muted-foreground">{rows.length}</span>
        </div>
        <div className="flex items-center gap-1">
          {SORTS.map((s) => (
            <Link
              key={s.key}
              href={`/contacts?sort=${s.key}${archived ? "&archived=1" : ""}`}
              className={`rounded px-2 py-1 text-xs ${
                sort === s.key
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {s.label}
            </Link>
          ))}
          <Link
            href={archived ? "/contacts" : "/contacts?archived=1"}
            className="ml-2 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {archived ? "Active" : "Archived"}
          </Link>
          <Button asChild size="sm" className="ml-3">
            <Link href="/contacts/new">New contact</Link>
          </Button>
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-xs text-muted-foreground">
          {archived
            ? "Nothing archived."
            : "No contacts yet — create one, or import your data (Phase 3)."}
        </p>
      ) : (
        <ul>
          {rows.map((c) => (
            <li key={c.id}>
              <Link
                href={`/contacts/${c.id}`}
                className="flex items-center gap-3 border-b border-border/60 px-5 py-2 transition-colors hover:bg-accent/50"
              >
                {c.starred ? (
                  <Star className="size-3 shrink-0 fill-yellow-500 text-yellow-500" />
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <span className="w-56 truncate font-medium">
                  {c.displayName}
                </span>
                <span className="w-44 truncate text-muted-foreground">
                  {c.title}
                </span>
                <span className="w-44 truncate text-muted-foreground">
                  {c.company}
                </span>
                <span className="flex flex-1 gap-1 overflow-hidden">
                  {c.tags.map((t) => (
                    <Badge
                      key={t.id}
                      variant="outline"
                      className="shrink-0"
                      style={{ borderColor: t.color, color: t.color }}
                    >
                      {t.name}
                    </Badge>
                  ))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
