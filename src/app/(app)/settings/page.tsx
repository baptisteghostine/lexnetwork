import { CustomFieldsManager } from "@/components/custom-fields-manager";
import { DataPanel } from "@/components/data-panel";
import { IntegrationsPanel } from "@/components/integrations-panel";
import { SettingsForm } from "@/components/settings-form";
import { Separator } from "@/components/ui/separator";
import { requireAuth } from "@/lib/auth";
import { listCustomFields } from "@/server/custom-fields";
import { readDataStatus } from "@/server/data";
import { readIntegrations } from "@/server/integrations";
import { readAppSettings } from "@/server/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const initial = await readAppSettings();
  const fields = await listCustomFields();
  const integrations = await readIntegrations();
  const dataStatus = await readDataStatus();
  return (
    <div>
      <header className="border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>
      <SettingsForm initial={initial} />
      <div className="max-w-lg space-y-3 px-5 pb-4">
        <Separator />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Integrations
        </h2>
        <IntegrationsPanel
          google={integrations.google}
          linkedin={integrations.linkedin}
          voyager={integrations.voyager}
        />
      </div>
      <div className="max-w-lg space-y-3 px-5 pb-4">
        <Separator />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Data
        </h2>
        <DataPanel status={dataStatus} />
      </div>
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
