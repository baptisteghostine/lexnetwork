"use client";

import { useActionState, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createGroupAction,
  deleteGroupAction,
  updateGroupAction,
} from "@/server/groups";

export type GroupRow = {
  id: number;
  name: string;
  emoji: string | null;
  parentId: number | null;
};

/** Flattens the hierarchy into indented rows, depth-first. */
export function flattenGroups(
  rows: GroupRow[]
): { group: GroupRow; depth: number }[] {
  const byParent = new Map<number | null, GroupRow[]>();
  for (const g of rows) {
    const list = byParent.get(g.parentId) ?? [];
    list.push(g);
    byParent.set(g.parentId, list);
  }
  const out: { group: GroupRow; depth: number }[] = [];
  const walk = (parentId: number | null, depth: number) => {
    for (const g of byParent.get(parentId) ?? []) {
      out.push({ group: g, depth });
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function GroupManager({ groups }: { groups: GroupRow[] }) {
  const flat = flattenGroups(groups);
  return (
    <div className="max-w-md space-y-5 px-5 py-4">
      <NewGroupForm groups={flat} />
      <ul className="space-y-0.5">
        {flat.map(({ group, depth }) => (
          <GroupItem key={group.id} group={group} depth={depth} />
        ))}
      </ul>
      {groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No groups yet. Groups are hierarchical collections with an emoji —
          “🗽 NYC” with “🍕 NYC Founders” inside it.
        </p>
      ) : null}
    </div>
  );
}

function NewGroupForm({
  groups,
}: {
  groups: { group: GroupRow; depth: number }[];
}) {
  const [state, formAction, pending] = useActionState(createGroupAction, {});
  return (
    <form action={formAction} className="space-y-2">
      <div className="flex gap-2">
        <Input name="emoji" placeholder="🏷️" className="w-14 text-center" />
        <Input name="name" placeholder="New group name" className="flex-1" />
        <Button type="submit" disabled={pending}>
          Add group
        </Button>
      </div>
      <select
        name="parentId"
        className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-[13px] text-muted-foreground"
        defaultValue=""
      >
        <option value="" className="bg-popover">
          No parent (top level)
        </option>
        {groups.map(({ group, depth }) => (
          <option key={group.id} value={group.id} className="bg-popover">
            {" ".repeat(depth * 3)}
            {group.emoji ? `${group.emoji} ` : ""}
            {group.name}
          </option>
        ))}
      </select>
      {state.error ? (
        <p className="text-xs text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

function GroupItem({ group, depth }: { group: GroupRow; depth: number }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [emoji, setEmoji] = useState(group.emoji ?? "");
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  if (!editing) {
    return (
      <li
        className="flex items-center justify-between rounded-md px-1 py-1 hover:bg-accent/50"
        style={{ marginLeft: depth * 16 }}
      >
        <span className="text-[13px]">
          {group.emoji ? `${group.emoji} ` : ""}
          {group.name}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={pending}
            onClick={() => startTransition(() => deleteGroupAction(group.id))}
          >
            <Trash2 className="text-destructive" />
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li
      className="space-y-2 rounded-md border border-border p-2"
      style={{ marginLeft: depth * 16 }}
    >
      <div className="flex gap-2">
        <Input
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
          className="w-14 text-center"
        />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1"
        />
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const fd = new FormData();
              fd.set("name", name);
              fd.set("emoji", emoji);
              const res = await updateGroupAction(group.id, {}, fd);
              if (res.error) setError(res.error);
              else setEditing(false);
            })
          }
        >
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </li>
  );
}
