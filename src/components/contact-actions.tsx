"use client";

import { useState, useTransition } from "react";
import { Archive, ArchiveRestore, Star, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  deleteContactAction,
  setArchivedAction,
  toggleStarAction,
} from "@/server/contacts";

export function ContactActions({
  contactId,
  displayName,
  starred,
  archived,
}: {
  contactId: number;
  displayName: string;
  starred: boolean;
  archived: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [confirmName, setConfirmName] = useState("");
  const [deleteError, setDeleteError] = useState<string | undefined>();

  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="ghost"
        size="icon"
        title={starred ? "Unstar" : "Star"}
        disabled={pending}
        onClick={() => startTransition(() => toggleStarAction(contactId))}
      >
        <Star
          className={starred ? "fill-yellow-500 text-yellow-500" : undefined}
        />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title={archived ? "Unarchive" : "Archive"}
        disabled={pending}
        onClick={() =>
          startTransition(() => setArchivedAction(contactId, !archived))
        }
      >
        {archived ? <ArchiveRestore /> : <Archive />}
      </Button>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost" size="icon" title="Delete">
            <Trash2 className="text-destructive" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {displayName}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the contact and everything attached to
              them. Merging is the safe path for duplicates — delete is for
              junk rows. Type the contact&apos;s name to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            placeholder={displayName}
          />
          {deleteError ? (
            <p className="text-xs text-destructive">{deleteError}</p>
          ) : null}
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={pending || confirmName.trim() !== displayName}
              onClick={() =>
                startTransition(async () => {
                  const res = await deleteContactAction(contactId, confirmName);
                  if (res?.error) setDeleteError(res.error);
                })
              }
            >
              Delete forever
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
