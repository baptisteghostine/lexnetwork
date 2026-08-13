import { SettingsForm } from "@/components/settings-form";
import { requireAuth } from "@/lib/auth";
import { readAppSettings } from "@/server/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const initial = await readAppSettings();
  return (
    <div>
      <header className="border-b border-border px-5 py-2.5">
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>
      <SettingsForm initial={initial} />
    </div>
  );
}
