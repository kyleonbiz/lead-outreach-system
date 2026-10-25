"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FolderWithCount } from "@/lib/dms/types";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import { FolderCard } from "./folder-card";
import { FolderNameDialog } from "./folder-name-dialog";
import { Skeleton } from "@/components/ui/skeleton";

export function FolderGrid({
  folders,
  totalCount,
  activeFolderId,
  canManage,
  loading,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  folders: FolderWithCount[];
  totalCount: number;
  activeFolderId: string | null;
  canManage: boolean;
  loading?: boolean;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => Promise<unknown>;
  onRename: (id: string, name: string) => Promise<unknown>;
  onDelete: (folder: FolderWithCount) => Promise<unknown>;
}) {
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<FolderWithCount | null>(null);
  const [deleting, setDeleting] = useState<FolderWithCount | null>(null);

  return (
    <section aria-labelledby="folders-heading">
      <div className="mb-3 flex items-center justify-between">
        <h3 id="folders-heading" className="text-sm font-semibold">
          Folders
        </h3>
        {canManage && (
          <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
            <Plus /> New folder
          </Button>
        )}
      </div>
      {loading ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[74px] rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
          <FolderCard
            isAll
            name="All Files"
            count={totalCount}
            color="violet"
            active={activeFolderId === null}
            onSelect={() => onSelect(null)}
          />
          {folders.map((f) => (
            <FolderCard
              key={f.id}
              name={f.name}
              count={f.documentCount}
              color={f.color}
              active={activeFolderId === f.id}
              onSelect={() => onSelect(f.id)}
              onRename={canManage && !f.isSystem ? () => setRenaming(f) : undefined}
              onDelete={canManage && !f.isSystem ? () => setDeleting(f) : undefined}
            />
          ))}
        </div>
      )}

      <FolderNameDialog open={creating} onOpenChange={setCreating} onSubmit={async (n) => void (await onCreate(n))} />
      <FolderNameDialog
        open={renaming !== null}
        initialName={renaming?.name}
        onOpenChange={(o) => !o && setRenaming(null)}
        onSubmit={async (n) => void (await onRename(renaming!.id, n))}
      />
      <DeleteConfirmationDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ""}”?`}
        description="The folder is removed. Documents inside it are kept and remain available in All Files."
        confirmLabel="Delete folder"
        onConfirm={async () => {
          await onDelete(deleting!);
        }}
      />
    </section>
  );
}
