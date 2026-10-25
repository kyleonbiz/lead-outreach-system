"use client";

import { Clock, Star, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CATEGORY_LABELS, type DocumentRecord } from "@/lib/dms/types";
import { formatBytes } from "@/lib/dms/validation";
import { cn } from "@/lib/utils";
import { daysUntil, formatDate } from "./format";
import { fileKindOf } from "./file-kind";
import { Snippet } from "./snippet";

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
  const date = inTrash && doc.deletedAt ? `Deleted ${formatDate(doc.deletedAt)}` : formatDate(doc.createdAt);

  return (
    <article
      className="group relative flex w-full flex-col rounded-2xl border bg-card shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-panel"
      data-testid="document-card"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${doc.displayName}`}
        className="flex flex-1 flex-col items-center gap-3 rounded-2xl px-4 pb-4 pt-6 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn("flex size-16 items-center justify-center rounded-2xl", kind.tile)}>
          <kind.Icon className="size-8" aria-hidden />
        </span>

        <span className="w-full min-w-0">
          <span className="line-clamp-2 break-words text-sm font-bold leading-snug" title={doc.displayName}>
            {doc.displayName}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground tabular-nums">
            {formatBytes(doc.sizeBytes)} • {date}
          </span>
        </span>

        <span className="flex flex-wrap items-center justify-center gap-1.5">
          <Badge>{CATEGORY_LABELS[doc.category]}</Badge>
          {folderName && <Badge variant="muted">{folderName}</Badge>}
          {expiring !== null && expiring <= 30 && (
            <Badge variant={expiring < 0 ? "danger" : "warning"}>
              <Clock className="size-3" aria-hidden />
              {expiring < 0 ? "Expired" : `Expires in ${expiring}d`}
            </Badge>
          )}
        </span>

        {doc.snippet && (
          <span className="w-full rounded-lg bg-muted/60 px-2.5 py-1.5 text-left text-xs leading-snug text-muted-foreground">
            <span className="sr-only">Matching text: </span>
            <Snippet text={doc.snippet} className="line-clamp-3 break-words" />
          </span>
        )}

        {doc.tags.length > 0 && (
          <span className="flex flex-wrap justify-center gap-1.5" aria-label="Tags">
            {shownTags.map((t) => (
              <Badge key={t} variant="muted" className="text-[10px] font-semibold uppercase tracking-wide">
                {t}
              </Badge>
            ))}
            {extra > 0 && (
              <Badge variant="muted" className="text-[10px] font-semibold">
                +{extra}
              </Badge>
            )}
          </span>
        )}
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
          className="absolute right-2.5 top-2.5 flex size-9 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-muted disabled:pointer-events-none"
        >
          <Star className={cn("size-[18px]", doc.starred && "fill-amber-400 text-amber-500")} aria-hidden />
        </button>
      )}
    </article>
  );
}
