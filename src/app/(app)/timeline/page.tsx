import Link from "next/link";
import { desc, eq, isNotNull } from "drizzle-orm";
import {
  Bell,
  Calendar,
  Handshake,
  Mail,
  MessageSquare,
  StickyNote,
} from "lucide-react";

import { ContactAvatar } from "@/components/contact-avatar";
import { db } from "@/db/client";
import { contacts, interactions, notes } from "@/db/schema";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const KIND_META: Record<string, { icon: React.ReactNode; label: string }> = {
  note: { icon: <StickyNote className="size-3.5" />, label: "Note" },
  email: { icon: <Mail className="size-3.5" />, label: "Email" },
  meeting: { icon: <Calendar className="size-3.5" />, label: "Meeting" },
  message: { icon: <MessageSquare className="size-3.5" />, label: "Message" },
  manual: { icon: <Handshake className="size-3.5" />, label: "Caught up" },
  reminder_fired: { icon: <Bell className="size-3.5" />, label: "Reminder" },
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "note", label: "Notes" },
  { key: "manual", label: "Caught up" },
  { key: "reminder_fired", label: "Reminders" },
] as const;

type Item = {
  key: string;
  at: number;
  kind: string;
  text: string;
  contactId: number;
  contactName: string;
  contactHasPhoto: boolean;
};

export default async function GlobalTimelinePage({
  searchParams,
}: PageProps<"/timeline">) {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const params = await searchParams;
  const kindFilter = FILTERS.some((f) => f.key === params.kind)
    ? String(params.kind)
    : "all";

  const interactionRows =
    kindFilter === "note"
      ? []
      : db
          .select({
            id: interactions.id,
            kind: interactions.kind,
            occurredAt: interactions.occurredAt,
            title: interactions.title,
            contactId: interactions.contactId,
            contactName: contacts.displayName,
            photoPath: contacts.photoPath,
          })
          .from(interactions)
          .innerJoin(contacts, eq(contacts.id, interactions.contactId))
          .where(
            kindFilter === "all"
              ? undefined
              : eq(interactions.kind, kindFilter)
          )
          .orderBy(desc(interactions.occurredAt))
          .limit(100)
          .all();

  const noteRows =
    kindFilter === "all" || kindFilter === "note"
      ? db
          .select({
            id: notes.id,
            createdAt: notes.createdAt,
            bodyMd: notes.bodyMd,
            contactId: notes.contactId,
            contactName: contacts.displayName,
            photoPath: contacts.photoPath,
          })
          .from(notes)
          .innerJoin(contacts, eq(contacts.id, notes.contactId))
          .where(isNotNull(notes.contactId))
          .orderBy(desc(notes.createdAt))
          .limit(100)
          .all()
      : [];

  const items: Item[] = [
    ...interactionRows.map((r) => ({
      key: `i${r.id}`,
      at: r.occurredAt,
      kind: r.kind,
      text: r.title ?? (KIND_META[r.kind]?.label || r.kind),
      contactId: r.contactId,
      contactName: r.contactName,
      contactHasPhoto: r.photoPath !== null,
    })),
    ...noteRows.map((r) => ({
      key: `n${r.id}`,
      at: r.createdAt,
      kind: "note",
      text: r.bodyMd.replaceAll(/\s+/g, " ").slice(0, 140) || "Empty note",
      contactId: r.contactId as number,
      contactName: r.contactName,
      contactHasPhoto: r.photoPath !== null,
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 100);

  return (
    <div>
      <header className="flex items-center gap-3 border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">Timeline</h1>
        <span className="text-xs text-muted-foreground">
          everything, most recent first
        </span>
        <span className="flex-1" />
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={f.key === "all" ? "/timeline" : `/timeline?kind=${f.key}`}
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                kindFilter === f.key
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>
      </header>
      <div className="max-w-3xl px-5 py-4">
        {items.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">
            Nothing here yet — notes and interactions across your whole
            network appear in one stream.
          </p>
        ) : (
          <ol className="space-y-1">
            {items.map((item) => (
              <li key={item.key}>
                <Link
                  href={`/contacts/${item.contactId}`}
                  className="flex items-center gap-2.5 rounded-md border border-border/60 px-3 py-2 transition-colors hover:bg-accent/50"
                >
                  <span className="text-muted-foreground">
                    {KIND_META[item.kind]?.icon ?? KIND_META.manual.icon}
                  </span>
                  <ContactAvatar
                    contactId={item.contactId}
                    name={item.contactName}
                    hasPhoto={item.contactHasPhoto}
                    size="sm"
                  />
                  <span className="w-40 shrink-0 truncate text-[13px] font-medium">
                    {item.contactName}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                    {item.text}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {new Date(item.at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
