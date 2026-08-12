import Link from "next/link";
import { notFound } from "next/navigation";

import { ContactActions } from "@/components/contact-actions";
import { requireAuth } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { getContactDetail, listTags } from "@/server/queries";

export const dynamic = "force-dynamic";

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
  const { contact, emails, phones, socials, tagIds } = detail;
  const tagsById = new Map(listTags().map((t) => [t.id, t]));
  const contactTagList = tagIds
    .map((tid) => tagsById.get(tid))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));

  const birthday =
    contact.birthdayMonth && contact.birthdayDay
      ? `${String(contact.birthdayMonth).padStart(2, "0")}-${String(
          contact.birthdayDay
        ).padStart(2, "0")}${contact.birthdayYear ? `-${contact.birthdayYear}` : ""}`
      : null;

  return (
    <div>
      <header className="flex items-center justify-between border-b border-border px-5 py-2.5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm font-semibold">{contact.displayName}</h1>
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

      <div className="max-w-2xl space-y-5 px-5 py-4">
        <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          <Dt>Title</Dt>
          <Dd>{contact.title}</Dd>
          <Dt>Company</Dt>
          <Dd>{contact.company}</Dd>
          <Dt>Location</Dt>
          <Dd>{contact.location}</Dd>
          <Dt>Birthday</Dt>
          <Dd>{birthday}</Dd>
          <Dt>Bio</Dt>
          <Dd>{contact.bio}</Dd>
        </dl>

        {contactTagList.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {contactTagList.map((t) => (
              <Badge
                key={t.id}
                variant="outline"
                style={{ borderColor: t.color, color: t.color }}
              >
                {t.name}
              </Badge>
            ))}
          </div>
        )}

        {(emails.length > 0 || phones.length > 0 || socials.length > 0) && (
          <>
            <Separator />
            <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              {emails.map((e, i) => (
                <FragmentRow
                  key={`e${e.id}`}
                  label={i === 0 ? "Email" : ""}
                  value={
                    <a href={`mailto:${e.email}`} className="hover:underline">
                      {e.email}
                    </a>
                  }
                  suffix={e.label}
                />
              ))}
              {phones.map((p, i) => (
                <FragmentRow
                  key={`p${p.id}`}
                  label={i === 0 ? "Phone" : ""}
                  value={p.phoneRaw}
                  suffix={p.label}
                />
              ))}
              {socials.map((s, i) => (
                <FragmentRow
                  key={`s${s.id}`}
                  label={i === 0 ? "Links" : ""}
                  value={
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {s.url}
                    </a>
                  }
                  suffix={s.platform}
                />
              ))}
            </dl>
          </>
        )}

        {contact.descriptionMd ? (
          <>
            <Separator />
            {/* Rendered as plain text for now; markdown rendering + notes
                timeline arrive in Phase 2. */}
            <p className="whitespace-pre-wrap text-[13px] text-muted-foreground">
              {contact.descriptionMd}
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Dt({ children }: { children: React.ReactNode }) {
  return <dt className="text-muted-foreground">{children}</dt>;
}

function Dd({ children }: { children: React.ReactNode }) {
  return <dd>{children ?? <span className="text-muted-foreground/50">—</span>}</dd>;
}

function FragmentRow({
  label,
  value,
  suffix,
}: {
  label: string;
  value: React.ReactNode;
  suffix?: string | null;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-baseline gap-2">
        {value}
        {suffix ? (
          <span className="text-[11px] text-muted-foreground">{suffix}</span>
        ) : null}
      </dd>
    </>
  );
}
