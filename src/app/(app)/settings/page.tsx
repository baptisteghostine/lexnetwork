import { CustomFieldsManager } from "@/components/custom-fields-manager";
import { SettingsForm } from "@/components/settings-form";
import { Separator } from "@/components/ui/separator";
import { requireAuth } from "@/lib/auth";
import { listCustomFields } from "@/server/custom-fields";
import { readAppSettings } from "@/server/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const initial = await readAppSettings();
  const fields = await listCustomFields();
  return (
    <div>
      <header className="border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>
      <SettingsForm initial={initial} />
      <div className="max-w-lg space-y-3 px-5 pb-6">
        <Separator />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Custom fields
        </h2>
        <CustomFieldsManager fields={fields} />
      </div>
    </div>
  );
}
