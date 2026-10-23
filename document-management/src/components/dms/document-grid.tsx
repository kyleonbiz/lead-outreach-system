"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DocumentRecord, FolderWithCount } from "@/lib/dms/types";
import { DocumentCard } from "./document-card";

export function DocumentGrid({
  items,
  total,
  folders,
  inTrash,
  canEdit,
  hasMore,
  loadingMore,
  onOpen,
  onToggleStar,
  onRestore,
  onLoadMore,
}: {
  items: DocumentRecord[];
  total: number;
  folders: FolderWithCount[];
  inTrash: boolean;
  canEdit: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onOpen: (id: string) => void;
  onToggleStar: (doc: DocumentRecord) => void;
  onRestore: (doc: DocumentRecord) => void;
  onLoadMore: () => void;
}) {
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground" aria-live="polite">
        Showing {items.length} of {total} {total === 1 ? "document" : "documents"}
      </p>
      <ul className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {items.map((doc) => (
          <li key={doc.id} className="flex">
            <div className="flex w-full">
              <DocumentCard
                doc={doc}
                folderName={doc.folderId ? folderName.get(doc.folderId) : undefined}
                inTrash={inTrash}
                canEdit={canEdit}
                onOpen={() => onOpen(doc.id)}
                onToggleStar={() => onToggleStar(doc)}
                onRestore={() => onRestore(doc)}
              />
            </div>
          </li>
        ))}
      </ul>
      {hasMore && (
        <div className="mt-6 flex justify-center">
          <Button variant="outline" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="animate-spin" /> : null}
            {loadingMore ? "Loading…" : `Load more (${total - items.length} remaining)`}
          </Button>
        </div>
      )}
    </div>
  );
}
