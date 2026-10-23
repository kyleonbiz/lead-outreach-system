"use client";

import { useId } from "react";
import { History, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  type DocumentDetail,
  type DocumentVersion,
  type FolderWithCount,
} from "@/lib/dms/types";
import { formatBytes } from "@/lib/dms/validation";
import { formatDate, formatDateTime } from "./format";
import { fileKindOf } from "./file-kind";
import { FolderPicker } from "./folder-picker";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{children}</dd>
    </div>
  );
}

export function DocumentMetadata({
  doc,
  folders,
  canEdit,
  onMove,
  onCategory,
  onExpiry,
  onDownloadVersion,
}: {
  doc: DocumentDetail;
  folders: FolderWithCount[];
  canEdit: boolean;
  onMove: (folderId: string | null) => void;
  onCategory: (c: DocumentDetail["category"]) => void;
  onExpiry: (iso: string | null) => void;
  onDownloadVersion: (v: DocumentVersion) => void;
}) {
  const kind = fileKindOf(doc.mimeType, doc.originalName);
  const folderId = useId();
  const catId = useId();
  const expId = useId();

  return (
    <div className="space-y-5">
      <dl className="divide-y rounded-xl border px-4">
        <Row label="File type">{kind.label}</Row>
        <Row label="Size">{formatBytes(doc.sizeBytes)}</Row>
        <Row label="Uploaded">{formatDate(doc.createdAt)}</Row>
        <Row label="Uploaded by">{doc.uploadedByName}</Row>
        <Row label="Version">v{doc.currentVersion}</Row>
      </dl>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
        <div className="space-y-1.5">
          <Label htmlFor={folderId}>Folder</Label>
          <FolderPicker
            id={folderId}
            folders={folders}
            value={doc.folderId}
            onChange={onMove}
            disabled={!canEdit}
            noneLabel="No folder"
            ariaLabel="Move to folder"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={catId}>Category</Label>
          <Select value={doc.category} onValueChange={(v) => onCategory(v as DocumentDetail["category"])} disabled={!canEdit}>
            <SelectTrigger id={catId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={expId}>Expiration date (optional)</Label>
          <Input
            id={expId}
            type="date"
            disabled={!canEdit}
            value={doc.expiresAt ? doc.expiresAt.slice(0, 10) : ""}
            onChange={(e) => onExpiry(e.target.value ? new Date(`${e.target.value}T12:00:00Z`).toISOString() : null)}
          />
        </div>
      </div>

      {doc.versions.length > 0 && (
        <section aria-labelledby="versions-heading">
          <h4 id="versions-heading" className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <History className="size-4 text-muted-foreground" aria-hidden /> Version history
          </h4>
          <ul className="divide-y rounded-xl border">
            {doc.versions.map((v) => (
              <li key={v.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                <span className="rounded-md bg-accent px-1.5 py-0.5 font-semibold text-accent-foreground">v{v.versionNumber}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{v.createdByName}</span>
                  <span className="text-muted-foreground">
                    {formatDateTime(v.createdAt)} · {formatBytes(v.sizeBytes)}
                  </span>
                </span>
                {v.versionNumber === doc.currentVersion ? (
                  <span className="text-muted-foreground">Current</span>
                ) : (
                  <Button variant="ghost" size="icon-sm" aria-label={`Download version ${v.versionNumber}`} onClick={() => onDownloadVersion(v)}>
                    <Download />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
