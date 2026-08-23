import Link from "next/link";

import { CustomFieldsManager } from "@/components/custom-fields-manager";
import { DataPanel } from "@/components/data-panel";
import { IntegrationsPanel } from "@/components/integrations-panel";
import {
  GeneralSettings,
  KeepInTouchSettings,
  NotificationSettings,
} from "@/components/settings-form";
import { requireAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { listCustomFields } from "@/server/custom-fields";
import { readDataStatus } from "@/server/data";
import { readIntegrations } from "@/server/integrations";
import { readAppSettings } from "@/server/settings";

export const dynamic = "force-dynamic";

// Settings in the Dex anatomy (SPEC §12): a grouped sub-nav rail on the
// left, one section at a time in a centered column on the right — instead
// of every setting in one endless scroll. Sections are ?tab= links, so
// the whole shell stays server-rendered.

type SectionItem = {
  id: string;
  label: string;
  title: string;
  subtitle: string;
};

const SECTIONS: { group: string; items: SectionItem[] }[] = [
  {
    group: "Preferences",
    items: [
      { id: "general", label: "General", title: "General", subtitle: "Timezone, phone parsing, and the address emails link back to." },
      { id: "keep-in-touch", label: "Keep in touch", title: "Keep in touch", subtitle: "How snooze-all spreads people out, and which birthdays surface." },
      { id: "notifications", label: "Notifications", title: "Notifications", subtitle: "The daily digest, job-change emails, and the SMTP account they send through." },
    ],
  },
  {
    group: "Connections",
    items: [
      { id: "integrations", label: "Integrations", title: "Integrations", subtitle: "Google, LinkedIn, the browser extension, city placement, and map rendering." },
    ],
  },
  {
    group: "Data",
    items: [
      { id: "data", label: "Backup & export", title: "Backup & export", subtitle: "Nightly backups, and everything you own as one download." },
      { id: "custom-fields", label: "Custom fields", title: "Custom fields", subtitle: "Fields of your own on every contact — filterable like the built-in ones." },
    ],
  },
];

const ALL_SECTIONS = SECTIONS.flatMap((g) => g.items);

export default async function SettingsPage({
  searchParams,
}: PageProps<"/settings">) {
  // Pages guard themselves — see contacts/page.tsx for why.
  await requireAuth();
  const params = await searchParams;
  const requested = typeof params.tab === "string" ? params.tab : "general";
  const section =
    ALL_SECTIONS.find((s) => s.id === requested) ?? ALL_SECTIONS[0];
  const tab = section.id;

  const initial = await readAppSettings();
  const fields = tab === "custom-fields" ? await listCustomFields() : [];
  const integrations = tab === "integrations" ? await readIntegrations() : null;
  const dataStatus = tab === "data" ? await readDataStatus() : null;

  return (
    <div className="flex min-h-screen flex-col md:h-screen md:min-h-0 md:flex-row">
      {/* Phone: the rail becomes a scrollable pill bar (SPEC §12). */}
      <div className="flex gap-1.5 overflow-x-auto border-b border-border px-3 py-2 md:hidden">
        {ALL_SECTIONS.map((item) => (
          <Link
            key={item.id}
            href={`/settings?tab=${item.id}`}
            className={cn(
              "shrink-0 rounded-full px-3 py-1 text-[12px] transition-colors",
              tab === item.id
                ? "bg-primary font-medium text-primary-foreground"
                : "bg-muted text-muted-foreground"
            )}
          >
            {item.label}
          </Link>
        ))}
      </div>
      <aside className="hidden w-52 shrink-0 space-y-5 overflow-y-auto border-r border-border px-3 py-4 md:block">
        <h1 className="px-2 text-sm font-semibold">Settings</h1>
        {SECTIONS.map((g) => (
          <div key={g.group}>
            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {g.group}
            </p>
            <ul className="space-y-0.5">
              {g.items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={`/settings?tab=${item.id}`}
                    className={cn(
                      "block rounded-md px-2 py-1.5 text-[13px] transition-colors",
                      tab === item.id
                        ? "bg-accent font-medium text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>

      <main className="min-w-0 flex-1 md:overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-6 md:px-6 md:py-8">
          <header className="mb-5">
            <h2 className="text-xl font-semibold tracking-tight">
              {section.title}
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {section.subtitle}
            </p>
          </header>

          {tab === "general" && <GeneralSettings initial={initial} />}
          {tab === "keep-in-touch" && <KeepInTouchSettings initial={initial} />}
          {tab === "notifications" && (
            <NotificationSettings initial={initial} />
          )}
          {tab === "integrations" && integrations && (
            <IntegrationsPanel
              google={integrations.google}
              linkedin={integrations.linkedin}
              voyager={integrations.voyager}
              extensionToken={integrations.extensionToken}
              enrich={integrations.enrich}
              geocode={integrations.geocode}
              mapboxConfigured={integrations.mapboxConfigured}
            />
          )}
          {tab === "data" && dataStatus && <DataPanel status={dataStatus} />}
          {tab === "custom-fields" && <CustomFieldsManager fields={fields} />}
        </div>
      </main>
    </div>
  );
}
