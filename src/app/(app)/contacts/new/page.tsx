import { ContactForm, EMPTY_CONTACT } from "@/components/contact-form";
import { requireAuth } from "@/lib/auth";
import { createContactAction } from "@/server/contacts";
import { listTags } from "@/server/queries";

export const dynamic = "force-dynamic";

export default async function NewContactPage() {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const allTags = listTags();
  return (
    <div>
      <header className="border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">New contact</h1>
      </header>
      <ContactForm
        action={createContactAction}
        initial={EMPTY_CONTACT}
        allTags={allTags}
        submitLabel="Create contact"
      />
    </div>
  );
}
