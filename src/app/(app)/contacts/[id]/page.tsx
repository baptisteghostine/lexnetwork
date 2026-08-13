import Link from "next/link";
import { notFound } from "next/navigation";
import { CircleAlert, Star } from "lucide-react";

import { CadenceControl } from "@/components/cadence-control";
import { ContactActions } from "@/components/contact-actions";
import { ContactAvatar } from "@/components/contact-avatar";
import { CustomFieldValues } from "@/components/custom-field-values";
import { LogInteraction } from "@/components/log-interaction";
import { RelationshipsCard } from "@/components/relationships-card";
import { readRelationships } from "@/server/relationships";
import { AddNoteButton, Timeline } from "@/components/timeline";
import {
  getCustomFieldValues,
  listCustomFields,
} from "@/server/custom-fields";
import { requireAuth } from "@/lib/auth";
import { DAY_MS } from "@/lib/cadence/engine";
import { now as currentTime } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  getContactDetail,
  getContactGroupIds,
  getContactTimeline,
  listGroups,
  listTags,
} from "@/server/queries";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  user: "Edited by you",
  csv: "From CSV import",
  vcard: "From vCard import",
  linkedin: "From LinkedIn import",
  gmail: "From Gmail sync",
  calendar: "From Calendar sync",
};

export default async function ContactPage({
  params,
}: PageProps<"/contacts/[id]">) {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const { id } = await params;
  const contactId = Number(id);
  const detail = Number.isInteger(contactId)
    ? getContactDetail(contactId)
    : null;
  if (!detail) notFound();
  const {
    contact,
    emails,
    phones,
    socials,
    tagIds,
    provenance,
    workHistory,
    education,
  } = detail;
  const timeline = getContactTimeline(contactId);
  // A just-created empty note opens directly in edit mode.
  const newestEmptyNote = timeline.find(
    (i) => i.type === "note" && !i.mentionedOnly && i.note.bodyMd === ""
  );
  const newestEmptyNoteId =
    newestEmptyNote?.type === "note" ? newestEmptyNote.note.id : null;
  const tagsById = new Map(listTags().map((t) => [t.id, t]));
  const contactTagList = tagIds
    .map((tid) => tagsById.get(tid))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  const groupIds = new Set(getContactGroupIds(contactId));
  const contactGroups = listGroups().filter((g) => groupIds.has(g.id));
  const customFields = await listCustomFields();
  const customValues = await getCustomFieldValues(contactId);
  const relationships = await readRelationships(contactId);

  const birthday =
    contact.birthdayMonth && contact.birthdayDay
      ? new Date(
          2000,
          contact.birthdayMonth - 1,
          contact.birthdayDay
        ).toLocaleDateString(undefined, { month: "long", day: "numeric" }) +
        (contact.birthdayYear ? `, ${contact.birthdayYear}` : "")
      : null;

  const nowMs = currentTime();
  const daysOverdue =
    contact.nextTouchAt !== null && contact.nextTouchAt <= nowMs
      ? Math.floor((nowMs - contact.nextTouchAt) / DAY_MS)
      : null;

  // SPEC §1: hovering a field shows where its value came from.
  const sourceTitle = (field: string): string | undefined => {
    const p = provenance[field];
    if (!p) return undefined;
    const label = SOURCE_LABEL[p.source] ?? `From ${p.source}`;
    return `${label} · ${new Date(p.updatedAt).toLocaleDateString()}`;
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-2.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Link href="/contacts" className="hover:text-foreground">
            Contacts
          </Link>
          <span>/</span>
          <span className="font-medium text-foreground">
            {contact.displayName}
          </span>
          {contact.archivedAt ? (
            <Badge variant="secondary">archived</Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <ContactActions
            contactId={contact.id}
            displayName={contact.displayName}
            starred={contact.starred}
            archived={contact.archivedAt !== null}
          />
          <Button asChild variant="outline" size="sm">
            <Link href={`/contacts/${contact.id}/edit`}>Edit</Link>
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Detail panel (Dex anatomy: fields left, timeline right) */}
        <aside className="w-80 shrink-0 space-y-4 overflow-y-auto border-r border-border bg-card/40 px-5 py-4">
          <div className="flex items-start gap-3">
            <ContactAvatar
              contactId={contact.id}
              name={contact.displayName}
              hasPhoto={contact.photoPath !== null}
              size="lg"
            />
            <div className="min-w-0 pt-0.5">
              <div className="flex items-center gap-1.5">
                <h1 className="truncate text-[15px] font-semibold">
                  {contact.displayName}
                </h1>
                {contact.starred ? (
                  <Star className="size-3.5 shrink-0 fill-warning text-warning" />
                ) : null}
              </div>
              {(contact.title || contact.company) && (
                <p className="truncate text-xs text-muted-foreground">
                  {[contact.title, contact.company]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              {daysOverdue !== null ? (
                <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-overdue">
                  <CircleAlert className="size-3" />
                  {daysOverdue === 0
                    ? "Due today"
                    : `Overdue ${daysOverdue}d`}
                </p>
              ) : null}
            </div>
          </div>

          <CadenceControl
            contactId={contact.id}
            cadenceDays={contact.cadenceDays}
            nextTouchAt={contact.nextTouchAt}
            snoozedUntil={contact.snoozedUntil}
          />

          {(contactTagList.length > 0 || contactGroups.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {contactTagList.map((t) => (
                <Badge
                  key={t.id}
                  variant="outline"
                  style={{ borderColor: t.color, color: t.color }}
                >
                  {t.name}
                </Badge>
              ))}
              {contactGroups.map((g) => (
                <Badge key={`g${g.id}`} variant="secondary">
                  {g.emoji ? `${g.emoji} ` : ""}
                  {g.name}
                </Badge>
              ))}
            </div>
          )}

          <Separator />

          <dl className="space-y-2.5 text-[13px]">
            <Field label="Title" title={sourceTitle("title")}>
              {contact.title}
            </Field>
            <Field label="Company" title={sourceTitle("company")}>
              {contact.company}
            </Field>
            <Field label="Location" title={sourceTitle("location")}>
              {contact.location}
            </Field>
            <Field label="Birthday" title={sourceTitle("birthday")}>
              {birthday}
            </Field>
            <Field label="Bio" title={sourceTitle("bio")}>
              {contact.bio}
            </Field>
            {emails.length > 0 ? (
              <Field label={emails.length > 1 ? "Emails" : "Email"}>
                {emails.map((e) => (
                  <span key={e.id} className="flex items-baseline gap-2">
                    <a
                      href={`mailto:${e.email}`}
                      className="truncate hover:underline"
                    >
                      {e.email}
                    </a>
                    {e.label ? (
                      <span className="text-[11px] text-muted-foreground">
                        {e.label}
                      </span>
                    ) : null}
                  </span>
                ))}
              </Field>
            ) : null}
            {phones.length > 0 ? (
              <Field label={phones.length > 1 ? "Phones" : "Phone"}>
                {phones.map((p) => (
                  <span key={p.id} className="flex items-baseline gap-2">
                    {p.phoneRaw}
                    {p.label ? (
                      <span className="text-[11px] text-muted-foreground">
                        {p.label}
                      </span>
                    ) : null}
                  </span>
                ))}
              </Field>
            ) : null}
            {socials.length > 0 ? (
              <Field label="Links">
                {socials.map((s) => (
                  <a
                    key={s.id}
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate hover:underline"
                  >
                    {s.url.replace(/^https?:\/\/(www\.)?/, "")}
                  </a>
                ))}
              </Field>
            ) : null}
          </dl>

          {workHistory.length > 0 ? (
            <>
              <Separator />
              <div className="space-y-1.5">
                <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Work history
                </h3>
                {workHistory.map((w) => (
                  <div key={w.id} className="text-[13px]">
                    <span className="font-medium">{w.company}</span>
                    {w.title ? (
                      <span className="text-muted-foreground"> · {w.title}</span>
                    ) : null}
                    <span className="block text-[11px] text-muted-foreground">
                      {w.isCurrent
                        ? `${w.startDate ?? "…"} – now`
                        : `${w.startDate ?? "…"} – ${w.endDate ?? "…"}`}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {education.length > 0 ? (
            <>
              <Separator />
              <div className="space-y-1.5">
                <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Education
                </h3>
                {education.map((e) => (
                  <div key={e.id} className="text-[13px]">
                    <span className="font-medium">{e.school}</span>
                    {e.degree || e.field ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · {[e.degree, e.field].filter(Boolean).join(", ")}
                      </span>
                    ) : null}
                    {e.endYear ? (
                      <span className="block text-[11px] text-muted-foreground">
                        {e.startYear ? `${e.startYear} – ` : ""}
                        {e.endYear}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {customFields.length > 0 ? (
            <>
              <Separator />
              <CustomFieldValues
                contactId={contact.id}
                fields={customFields}
                values={customValues}
              />
            </>
          ) : null}

          <Separator />
          <RelationshipsCard contactId={contact.id} edges={relationships} />

          {contact.descriptionMd ? (
            <>
              <Separator />
              <p
                className="whitespace-pre-wrap text-[13px] text-muted-foreground"
                title={sourceTitle("description_md")}
              >
                {contact.descriptionMd}
              </p>
            </>
          ) : null}
        </aside>

        {/* Timeline stream */}
        <main className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mx-auto max-w-2xl space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Timeline
              </h2>
              <div className="flex gap-2">
                <LogInteraction contactId={contact.id} />
                <AddNoteButton contactId={contact.id} />
              </div>
            </div>
            <Timeline items={timeline} newestNoteId={newestEmptyNoteId} />
          </div>
        </main>
      </div>
    </div>
  );
}

function Field({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  const empty =
    children === null || children === undefined || children === "";
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-x-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 cursor-default" title={title}>
        {empty ? <span className="text-muted-foreground/50">—</span> : children}
      </dd>
    </div>
  );
}
