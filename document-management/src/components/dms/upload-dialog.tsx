"use client";

import { AlertCircle, CheckCircle2, CloudUpload, Info, Loader2, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import type { DmsApi } from "@/lib/dms/client/api";
import type { DocumentRecord, FolderWithCount, StorageUsage, UploadLimits } from "@/lib/dms/types";
import { formatBytes } from "@/lib/dms/validation";
import { cn } from "@/lib/utils";
import { fileKindOf } from "./file-kind";
import { FileDropzone } from "./file-dropzone";
import { FolderPicker } from "./folder-picker";
import { useUploadQueue, type UploadItem } from "./use-upload-queue";

export function UploadDialog({
  open,
  onOpenChange,
  api,
  limits,
  folders,
  folderId,
  onFolderChange,
  usage,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: DmsApi;
  limits: UploadLimits;
  folders: FolderWithCount[];
  folderId: string | null;
  onFolderChange: (id: string | null) => void;
  usage: StorageUsage;
  onUploaded: (doc: DocumentRecord) => void;
}) {
  const queue = useUploadQueue({
    api,
    limits,
    folderId,
    remainingBytes: Math.max(0, usage.quotaBytes - usage.usedBytes),
    onUploaded,
  });

  const accept = [...new Set(limits.allowedTypes.map((t) => `.${t.extension}`))].join(",");
  const exts = [...new Set(limits.allowedTypes.map((t) => t.extension.toUpperCase()))].filter((e) => e !== "JPEG");
  const hint = `${exts.slice(0, 7).join(", ")}${exts.length > 7 ? " and more" : ""} • Max ${formatBytes(limits.maxFileSizeBytes)} each`;
  const pct = usage.quotaBytes > 0 ? Math.min(100, Math.round((usage.usedBytes / usage.quotaBytes) * 100)) : 0;
  const folderLabel = folders.find((f) => f.id === folderId)?.name ?? "All Files";
  const done = queue.items.filter((i) => i.status === "success").length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent variant="upload" aria-describedby="upload-desc" showClose={false}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-3 border-b px-5 py-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <CloudUpload className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base">Upload Documents</DialogTitle>
              <DialogDescription id="upload-desc" className="text-xs">
                Drag and drop or browse your files
              </DialogDescription>
            </div>
            <DialogClose
              aria-label="Close"
              className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" />
            </DialogClose>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
            <div className="space-y-1.5">
              <Label htmlFor="upload-folder">Destination folder</Label>
              <FolderPicker id="upload-folder" folders={folders} value={folderId} onChange={onFolderChange} />
            </div>

            <FileDropzone accept={accept} hint={hint} onFiles={queue.addFiles} />

            {queue.items.length > 0 && (
              <ul className="space-y-2" aria-label="Upload progress">
                {queue.items.map((item) => (
                  <UploadRow key={item.id} item={item} onCancel={() => queue.cancel(item.id)} onRetry={() => queue.retry(item.id)} />
                ))}
              </ul>
            )}

            <div className="flex gap-2.5 rounded-xl bg-slate-50 px-4 py-3 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <div>
                <p>
                  Files will be uploaded to <strong className="text-foreground">{folderLabel}</strong>
                </p>
                <p className="mt-0.5 text-[11px]">
                  Storage {formatBytes(usage.usedBytes)} of {formatBytes(usage.quotaBytes)} used ({pct}%)
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {queue.busy ? "Uploading…" : done > 0 ? `${done} uploaded` : "Nothing uploaded yet"}
            </p>
            <div className="flex gap-2">
              {queue.items.some((i) => i.status !== "uploading") && (
                <Button variant="ghost" size="sm" onClick={queue.clearFinished}>
                  Clear list
                </Button>
              )}
              <Button variant={queue.busy ? "outline" : "default"} onClick={() => onOpenChange(false)}>
                {queue.busy ? "Continue in background" : "Done"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UploadRow({ item, onCancel, onRetry }: { item: UploadItem; onCancel: () => void; onRetry: () => void }) {
  const kind = fileKindOf(item.file.type, item.file.name);
  return (
    <li
      className={cn(
        "rounded-xl border p-3",
        item.status === "error" && "border-red-200 bg-red-50/60",
        item.status === "success" && "border-emerald-200 bg-emerald-50/50",
      )}
      data-testid="upload-row"
      data-status={item.status}
    >
      <div className="flex items-center gap-3">
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", kind.tile)}>
          <kind.Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={item.file.name}>
            {item.file.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatBytes(item.file.size)}
            {item.status === "uploading" && ` · ${item.progress}%`}
            {item.status === "success" && " · Uploaded"}
          </p>
        </div>
        {item.status === "uploading" && (
          <>
            <Loader2 className="size-4 animate-spin text-violet-500" aria-hidden />
            <Button variant="ghost" size="icon-sm" aria-label={`Cancel upload of ${item.file.name}`} onClick={onCancel}>
              <X />
            </Button>
          </>
        )}
        {item.status === "success" && <CheckCircle2 className="size-5 text-emerald-500" aria-label="Upload complete" />}
        {(item.status === "error" || item.status === "cancelled") && (
          <>
            <AlertCircle className={cn("size-5", item.status === "error" ? "text-destructive" : "text-muted-foreground")} aria-hidden />
            {item.status === "cancelled" || item.error?.includes("Network") || item.error?.includes("failed") ? (
              <Button variant="ghost" size="icon-sm" aria-label={`Retry ${item.file.name}`} onClick={onRetry}>
                <RotateCw />
              </Button>
            ) : null}
          </>
        )}
      </div>
      {item.status === "uploading" && (
        <Progress value={item.progress} className="mt-2 h-1.5" aria-label={`Uploading ${item.file.name}`} />
      )}
      {(item.status === "error" || item.status === "cancelled") && item.error && (
        <p role={item.status === "error" ? "alert" : undefined} className="mt-2 text-xs text-destructive">
          {item.error}
        </p>
      )}
    </li>
  );
}
