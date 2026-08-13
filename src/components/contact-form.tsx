"use client";

import { useActionState, useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ContactFormState, ContactPayload } from "@/server/contacts";

type EmailRow = { email: string; label: string };
type PhoneRow = { phone: string; label: string };
type SocialRow = { platform: ContactPayload["socials"][number]["platform"]; url: string };
type TagOption = { id: number; name: string; color: string };
type GroupOption = { id: number; name: string; emoji: string | null };

export type ContactFormInitial = {
  firstName: string;
  lastName: string;
  title: string;
  company: string;
  location: string;
  bio: string;
  descriptionMd: string;
  birthdayMonth: number | null;
  birthdayDay: number | null;
  birthdayYear: number | null;
  emails: EmailRow[];
  phones: PhoneRow[];
  socials: SocialRow[];
  tagIds: number[];
  groupIds: number[];
};

export const EMPTY_CONTACT: ContactFormInitial = {
  firstName: "",
  lastName: "",
  title: "",
  company: "",
  location: "",
  bio: "",
  descriptionMd: "",
  birthdayMonth: null,
  birthdayDay: null,
  birthdayYear: null,
  emails: [],
  phones: [],
  socials: [],
  tagIds: [],
  groupIds: [],
};

const PLATFORMS = ["linkedin", "twitter", "github", "website", "other"] as const;

export function ContactForm({
  action,
  initial,
  allTags,
  allGroups,
  submitLabel,
}: {
  action: (
    prev: ContactFormState,
    formData: FormData
  ) => Promise<ContactFormState>;
  initial: ContactFormInitial;
  allTags: TagOption[];
  allGroups: GroupOption[];
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [form, setForm] = useState<ContactFormInitial>(initial);

  const set = <K extends keyof ContactFormInitial>(
    key: K,
    value: ContactFormInitial[K]
  ) => setForm((f) => ({ ...f, [key]: value }));

  const moveRow = <T,>(rows: T[], i: number, dir: -1 | 1): T[] => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return rows;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };

  return (
    <form action={formAction} className="max-w-2xl space-y-6 px-5 py-4">
      <input type="hidden" name="payload" value={JSON.stringify(form)} />

      <section className="grid grid-cols-2 gap-3">
        <Field label="First name">
          <Input
            value={form.firstName}
            onChange={(e) => set("firstName", e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Last name">
          <Input
            value={form.lastName}
            onChange={(e) => set("lastName", e.target.value)}
          />
        </Field>
        <Field label="Title">
          <Input
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
          />
        </Field>
        <Field label="Company">
          <Input
            value={form.company}
            onChange={(e) => set("company", e.target.value)}
          />
        </Field>
        <Field label="Location">
          <Input
            value={form.location}
            onChange={(e) => set("location", e.target.value)}
          />
        </Field>
        <Field label="Birthday (month / day / year — year optional)">
          <div className="flex gap-2">
            <Input
              type="number"
              min={1}
              max={12}
              placeholder="MM"
              className="w-16"
              value={form.birthdayMonth ?? ""}
              onChange={(e) =>
                set(
                  "birthdayMonth",
                  e.target.value === "" ? null : Number(e.target.value)
                )
              }
            />
            <Input
              type="number"
              min={1}
              max={31}
              placeholder="DD"
              className="w-16"
              value={form.birthdayDay ?? ""}
              onChange={(e) =>
                set(
                  "birthdayDay",
                  e.target.value === "" ? null : Number(e.target.value)
                )
              }
            />
            <Input
              type="number"
              min={1900}
              max={2100}
              placeholder="YYYY"
              className="w-20"
              value={form.birthdayYear ?? ""}
              onChange={(e) =>
                set(
                  "birthdayYear",
                  e.target.value === "" ? null : Number(e.target.value)
                )
              }
            />
          </div>
        </Field>
      </section>

      <Field label="Bio (one line)">
        <Input value={form.bio} onChange={(e) => set("bio", e.target.value)} />
      </Field>

      <RowSection
        title="Emails"
        rows={form.emails}
        onAdd={() =>
          set("emails", [...form.emails, { email: "", label: "" }])
        }
        render={(row, i) => (
          <>
            <Input
              type="email"
              placeholder="email@example.com"
              className="flex-1"
              value={row.email}
              onChange={(e) => {
                const rows = [...form.emails];
                rows[i] = { ...row, email: e.target.value };
                set("emails", rows);
              }}
            />
            <Input
              placeholder="label"
              className="w-24"
              value={row.label}
              onChange={(e) => {
                const rows = [...form.emails];
                rows[i] = { ...row, label: e.target.value };
                set("emails", rows);
              }}
            />
            {i === 0 && (
              <span className="text-[10px] uppercase text-muted-foreground">
                primary
              </span>
            )}
          </>
        )}
        onMove={(i, dir) => set("emails", moveRow(form.emails, i, dir))}
        onRemove={(i) =>
          set(
            "emails",
            form.emails.filter((_, j) => j !== i)
          )
        }
      />

      <RowSection
        title="Phones"
        rows={form.phones}
        onAdd={() => set("phones", [...form.phones, { phone: "", label: "" }])}
        render={(row, i) => (
          <>
            <Input
              placeholder="+1 555 000 0000"
              className="flex-1"
              value={row.phone}
              onChange={(e) => {
                const rows = [...form.phones];
                rows[i] = { ...row, phone: e.target.value };
                set("phones", rows);
              }}
            />
            <Input
              placeholder="label"
              className="w-24"
              value={row.label}
              onChange={(e) => {
                const rows = [...form.phones];
                rows[i] = { ...row, label: e.target.value };
                set("phones", rows);
              }}
            />
            {i === 0 && (
              <span className="text-[10px] uppercase text-muted-foreground">
                primary
              </span>
            )}
          </>
        )}
        onMove={(i, dir) => set("phones", moveRow(form.phones, i, dir))}
        onRemove={(i) =>
          set(
            "phones",
            form.phones.filter((_, j) => j !== i)
          )
        }
      />

      <RowSection
        title="Social links"
        rows={form.socials}
        onAdd={() =>
          set("socials", [...form.socials, { platform: "linkedin", url: "" }])
        }
        render={(row, i) => (
          <>
            <select
              className="h-8 rounded-md border border-input bg-transparent px-2 text-[13px]"
              value={row.platform}
              onChange={(e) => {
                const rows = [...form.socials];
                rows[i] = {
                  ...row,
                  platform: e.target.value as SocialRow["platform"],
                };
                set("socials", rows);
              }}
            >
              {PLATFORMS.map((p) => (
                <option key={p} value={p} className="bg-popover">
                  {p}
                </option>
              ))}
            </select>
            <Input
              placeholder="https://…"
              className="flex-1"
              value={row.url}
              onChange={(e) => {
                const rows = [...form.socials];
                rows[i] = { ...row, url: e.target.value };
                set("socials", rows);
              }}
            />
          </>
        )}
        onMove={(i, dir) => set("socials", moveRow(form.socials, i, dir))}
        onRemove={(i) =>
          set(
            "socials",
            form.socials.filter((_, j) => j !== i)
          )
        }
      />

      {allTags.length > 0 && (
        <section className="space-y-2">
          <Label>Tags</Label>
          <div className="flex flex-wrap gap-1.5">
            {allTags.map((t) => {
              const active = form.tagIds.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() =>
                    set(
                      "tagIds",
                      active
                        ? form.tagIds.filter((id) => id !== t.id)
                        : [...form.tagIds, t.id]
                    )
                  }
                >
                  <Badge
                    variant="outline"
                    style={
                      active
                        ? { backgroundColor: t.color, borderColor: t.color, color: "#fff" }
                        : { borderColor: t.color, color: t.color }
                    }
                  >
                    {t.name}
                  </Badge>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {allGroups.length > 0 && (
        <section className="space-y-2">
          <Label>Groups</Label>
          <div className="flex flex-wrap gap-1.5">
            {allGroups.map((g) => {
              const active = form.groupIds.includes(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() =>
                    set(
                      "groupIds",
                      active
                        ? form.groupIds.filter((id) => id !== g.id)
                        : [...form.groupIds, g.id]
                    )
                  }
                  className={`rounded-md border px-2 py-1 text-xs ${
                    active
                      ? "border-foreground bg-accent"
                      : "border-input text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {g.emoji ? `${g.emoji} ` : ""}
                  {g.name}
                </button>
              );
            })}
          </div>
        </section>
      )}

      <Field label="Notes about this person (markdown)">
        <Textarea
          rows={6}
          value={form.descriptionMd}
          onChange={(e) => set("descriptionMd", e.target.value)}
        />
      </Field>

      {state.error ? (
        <p className="text-xs text-destructive">{state.error}</p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function RowSection<T>({
  title,
  rows,
  render,
  onAdd,
  onMove,
  onRemove,
}: {
  title: string;
  rows: T[];
  render: (row: T, i: number) => React.ReactNode;
  onAdd: () => void;
  onMove: (i: number, dir: -1 | 1) => void;
  onRemove: (i: number) => void;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{title}</Label>
        <Button type="button" variant="ghost" size="sm" onClick={onAdd}>
          <Plus /> Add
        </Button>
      </div>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          {render(row, i)}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={i === 0}
            onClick={() => onMove(i, -1)}
          >
            <ArrowUp />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={i === rows.length - 1}
            onClick={() => onMove(i, 1)}
          >
            <ArrowDown />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onRemove(i)}
          >
            <X />
          </Button>
        </div>
      ))}
    </section>
  );
}
