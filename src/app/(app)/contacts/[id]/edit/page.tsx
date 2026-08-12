import { notFound } from "next/navigation";

import { ContactForm } from "@/components/contact-form";
import { requireAuth } from "@/lib/auth";
import { updateContactAction } from "@/server/contacts";
import { getContactDetail, listTags } from "@/server/queries";

export const dynamic = "force-dynamic";

export default async function EditContactPage({
  params,
}: PageProps<"/contacts/[id]/edit">) {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const { id } = await params;
  const contactId = Number(id);
  const detail = Number.isInteger(contactId)
    ? getContactDetail(contactId)
    : null;
  if (!detail) notFound();

  const { contact, emails, phones, socials, tagIds } = detail;
  return (
    <div>
      <header className="border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">Edit — {contact.displayName}</h1>
      </header>
      <ContactForm
        action={updateContactAction.bind(null, contactId)}
        initial={{
          firstName: contact.firstName ?? "",
          lastName: contact.lastName ?? "",
          title: contact.title ?? "",
          company: contact.company ?? "",
          location: contact.location ?? "",
          bio: contact.bio ?? "",
          descriptionMd: contact.descriptionMd ?? "",
          birthdayMonth: contact.birthdayMonth,
          birthdayDay: contact.birthdayDay,
          birthdayYear: contact.birthdayYear,
          emails: emails.map((e) => ({ email: e.email, label: e.label ?? "" })),
          phones: phones.map((p) => ({
            phone: p.phoneRaw,
            label: p.label ?? "",
          })),
          socials: socials.map((s) => ({
            platform: s.platform as
              | "linkedin"
              | "twitter"
              | "github"
              | "website"
              | "other",
            url: s.url,
          })),
          tagIds,
        }}
        allTags={listTags()}
        submitLabel="Save changes"
      />
    </div>
  );
}
