"use client";

import { Clock, Star, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CATEGORY_LABELS, type DocumentRecord } from "@/lib/dms/types";
import { formatBytes } from "@/lib/dms/validation";
import { cn } from "@/lib/utils";
import { daysUntil, formatDate } from "./format";
import { fileKindOf } from "./file-kind";

const MAX_TAGS = 3;

export function DocumentCard({
  doc,
  folderName,
  inTrash,
  canEdit,
  onOpen,
  onToggleStar,
  onRestore,
}: {
  doc: DocumentRecord;
  folderName?: string;
  inTrash: boolean;
  canEdit: boolean;
  onOpen: () => void;
  onToggleStar: () => void;
  onRestore: () => void;
}) {
  const kind = fileKindOf(doc.mimeType, doc.originalName);
  const expiring = doc.expiresAt ? daysUntil(doc.expiresAt) : null;
  const shownTags = doc.tags.slice(0, MAX_TAGS);
  const extra = doc.tags.length - shownTags.length;

  return (
    <article
      className="group relative flex w-full flex-col rounded-xl border bg-card transition-all hover:-translate-y-0.5 hover:shadow-panel"
      data-testid="document-card"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${doc.displayName}`}
        className="flex flex-1 flex-col gap-3 rounded-xl p-4 pr-12 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-start gap-3">
          <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl", kind.tile)}>
            <kind.Icon className="size-5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 break-words text-sm font-semibold leading-snug" title={doc.displayName}>
              {doc.displayName}
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
              {kind.label} · {formatBytes(doc.sizeBytes)}
            </span>
          </span>
        </span>

        <span className="flex flex-wrap items-center gap-1.5">
          <Badge>{CATEGORY_LABELS[doc.category]}</Badge>
          {folderName && !folderName.toLowerCase().startsWith(CATEGORY_LABELS[doc.category].toLowerCase().split(" ")[0]) && <Badge variant="muted">{folderName}</Badge>}
          {expiring !== null && expiring <= 30 && (
            <Badge variant={expiring < 0 ? "danger" : "warning"}>
              <Clock className="size-3" aria-hidden />
              {expiring < 0 ? "Expired" : `Expires in ${expiring}d`}
            </Badge>
          )}
        </span>

        {doc.tags.length > 0 && (
          <span className="flex flex-wrap gap-1.5" aria-label="Tags">
            {shownTags.map((t) => (
              <Badge key={t} variant="outline">
                #{t}
              </Badge>
            ))}
            {extra > 0 && <Badge variant="outline">+{extra}</Badge>}
          </span>
        )}

        <span className="mt-auto text-[11px] text-muted-foreground">
          {inTrash && doc.deletedAt ? `Deleted ${formatDate(doc.deletedAt)}` : `Uploaded ${formatDate(doc.createdAt)}`}
        </span>
      </button>

      {inTrash ? (
        canEdit && (
          <Button variant="outline" size="sm" className="absolute right-2.5 top-2.5" onClick={onRestore}>
            <Undo2 /> Restore
          </Button>
        )
      ) : (
        <button
          type="button"
          onClick={onToggleStar}
          disabled={!canEdit}
          aria-pressed={doc.starred}
          aria-label={doc.starred ? `Unstar ${doc.displayName}` : `Star ${doc.displayName}`}
          className="absolute right-2.5 top-2.5 flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none"
        >
          <Star className={cn("size-[18px]", doc.starred && "fill-amber-400 text-amber-500")} aria-hidden />
        </button>
      )}
    </article>
  );
}
