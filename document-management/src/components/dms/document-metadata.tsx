"use client";

import { useId } from "react";
import { Download, History } from "lucide-react";
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
import { contentStatusLabel } from "./snippet";

export function SectionLabel({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h4 id={id} className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h4>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium">{children}</dd>
    </div>
  );
}

/** Read-only FILE DETAILS rows. */
export function FileDetails({ doc, folders }: { doc: DocumentDetail; folders: FolderWithCount[] }) {
  const kind = fileKindOf(doc.mimeType, doc.originalName);
  const folder = folders.find((f) => f.id === doc.folderId)?.name ?? "—";
  return (
    <section aria-labelledby="details-heading">
      <SectionLabel id="details-heading">File details</SectionLabel>
      <dl>
        <Row label="Type">{kind.noun}</Row>
        <Row label="Size">{formatBytes(doc.sizeBytes)}</Row>
        <Row label="Category">{CATEGORY_LABELS[doc.category]}</Row>
        <Row label="Folder">{folder}</Row>
        <Row label="Uploaded">{formatDate(doc.createdAt)}</Row>
        <Row label="By">{doc.uploadedByName}</Row>
        <Row label="Version">v{doc.currentVersion}.0</Row>
        <Row label="Text search">{contentStatusLabel(doc.contentStatus, doc.contentReason)}</Row>
      </dl>
    </section>
  );
}

/** Editable properties (category, expiry) and version history. */
export function DocumentMetadata({
  doc,
  canEdit,
  onCategory,
  onExpiry,
  onDownloadVersion,
}: {
  doc: DocumentDetail;
  canEdit: boolean;
  onCategory: (c: DocumentDetail["category"]) => void;
  onExpiry: (iso: string | null) => void;
  onDownloadVersion: (v: DocumentVersion) => void;
}) {
  const catId = useId();
  const expId = useId();

  return (
    <div className="space-y-5">
      <section aria-labelledby="props-heading">
        <SectionLabel id="props-heading">Properties</SectionLabel>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={catId} className="text-xs text-muted-foreground">
              Category
            </Label>
            <Select value={doc.category} onValueChange={(v) => onCategory(v as DocumentDetail["category"])} disabled={!canEdit}>
              <SelectTrigger id={catId} className="h-9 rounded-lg text-xs">
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
          <div className="space-y-1">
            <Label htmlFor={expId} className="text-xs text-muted-foreground">
              Expiration date (optional)
            </Label>
            <Input
              id={expId}
              type="date"
              disabled={!canEdit}
              value={doc.expiresAt ? doc.expiresAt.slice(0, 10) : ""}
              onChange={(e) => onExpiry(e.target.value ? new Date(`${e.target.value}T12:00:00Z`).toISOString() : null)}
              className="h-9 rounded-lg text-xs"
            />
          </div>
        </div>
      </section>

      {doc.versions.length > 0 && (
        <section aria-labelledby="versions-heading">
          <SectionLabel id="versions-heading">
            <span className="inline-flex items-center gap-1.5">
              <History className="size-3.5" aria-hidden /> Version history
            </span>
          </SectionLabel>
          <ul className="divide-y rounded-xl border bg-card">
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
