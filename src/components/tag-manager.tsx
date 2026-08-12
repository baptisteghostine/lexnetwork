"use client";

import { useActionState, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createTagAction,
  deleteTagAction,
  updateTagAction,
  type TagFormState,
} from "@/server/tags";

const COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#78716c",
];

type TagRow = { id: number; name: string; color: string };

export function TagManager({ tags }: { tags: TagRow[] }) {
  return (
    <div className="max-w-md space-y-5 px-5 py-4">
      <NewTagForm />
      <ul className="space-y-1">
        {tags.map((t) => (
          <TagItem key={t.id} tag={t} />
        ))}
      </ul>
      {tags.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No tags yet. Tags are flat, colored labels — use them for things like
          “investor”, “met-at-conference”, “close-friend”.
        </p>
      ) : null}
    </div>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (c: string) => void;
}) {
  return (
    <div className="flex gap-1">
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`color ${c}`}
          className={`h-4 w-4 rounded-full ${
            value === c ? "ring-2 ring-ring ring-offset-1 ring-offset-background" : ""
          }`}
          style={{ backgroundColor: c }}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

function NewTagForm() {
  const [color, setColor] = useState(COLORS[5]);
  const [state, formAction, pending] = useActionState<TagFormState, FormData>(
    async (prev, fd) => {
      const res = await createTagAction(prev, fd);
      return res;
    },
    {}
  );
  return (
    <form action={formAction} className="space-y-2">
      <div className="flex gap-2">
        <Input name="name" placeholder="New tag name" className="flex-1" />
        <input type="hidden" name="color" value={color} />
        <Button type="submit" disabled={pending}>
          Add tag
        </Button>
      </div>
      <ColorPicker value={color} onChange={setColor} />
      {state.error ? (
        <p className="text-xs text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

function TagItem({ tag }: { tag: TagRow }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();

  if (!editing) {
    return (
      <li className="flex items-center justify-between rounded-md px-1 py-1 hover:bg-accent/50">
        <Badge variant="outline" style={{ borderColor: tag.color, color: tag.color }}>
          {tag.name}
        </Badge>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={pending}
            onClick={() => startTransition(() => deleteTagAction(tag.id))}
          >
            <Trash2 className="text-destructive" />
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="space-y-2 rounded-md border border-border p-2">
      <div className="flex gap-2">
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
              fd.set("color", color);
              const res = await updateTagAction(tag.id, {}, fd);
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
      <ColorPicker value={color} onChange={setColor} />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </li>
  );
}
