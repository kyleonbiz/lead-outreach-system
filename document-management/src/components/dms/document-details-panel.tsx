"use client";

import { useRef, useState } from "react";
import { Check, Download, Pencil, Share2, Star, Trash2, Undo2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { CATEGORY_LABELS } from "@/lib/dms/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import { DocumentMetadata } from "./document-metadata";
import { DocumentPreview } from "./document-preview";
import { fileKindOf } from "./file-kind";
import { ErrorState } from "./states";
import { ShareDialog } from "./share-dialog";
import { TagEditor } from "./tag-editor";
import type { DocumentManager } from "./use-document-manager";
import { normalizeRename } from "@/lib/dms/validation";

export function DocumentDetailsPanel({
  manager,
  onUploadVersion,
}: {
  manager: DocumentManager;
  onUploadVersion: (documentId: string, file: File) => Promise<void>;
}) {
  const { selectedId, detail, detailError, perms, boot, api } = manager;
  const doc = detail;
  const open = selectedId !== null;
  const inTrash = Boolean(doc?.deletedAt);
  const canEdit = perms.write && !inTrash;

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState("");
  const [sharing, setSharing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const versionInput = useRef<HTMLInputElement>(null);

  const kind = doc ? fileKindOf(doc.mimeType, doc.originalName) : null;

  function startRename() {
    if (!doc) return;
    setDraft(doc.displayName);
    setRenameError("");
    setRenaming(true);
  }

  async function commitRename() {
    if (!doc) return;
    const name = normalizeRename(draft, doc.originalName);
    if (!name) {
      setRenameError("Enter a valid file name.");
      return;
    }
    if (name === doc.displayName) {
      setRenaming(false);
      return;
    }
    const updated = await manager.update(doc.id, { displayName: name }, "Renamed.");
    if (updated) setRenaming(false);
    else setRenameError("Could not rename. Try again.");
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && manager.openDocument(null)}>
      <DialogContent
        className="sm:h-[min(780px,calc(100dvh-3rem))] sm:max-w-5xl"
        aria-describedby="details-desc"
        closeLabel="Close details"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          manager.restoreFocus();
        }}
      >
        <DialogDescription id="details-desc" className="sr-only">
          Document details, preview and actions
        </DialogDescription>

        {!doc && !detailError && (
          <div className="p-6">
            <DialogTitle className="sr-only">Loading document</DialogTitle>
            <Skeleton className="h-8 w-2/3" />
            <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_340px]">
              <Skeleton className="h-80" />
              <Skeleton className="h-80" />
            </div>
          </div>
        )}
        {detailError && (
          <div className="p-6">
            <DialogTitle className="sr-only">Document unavailable</DialogTitle>
            <ErrorState title="Could not open document" message={detailError} onRetry={() => selectedId && manager.openDocument(selectedId)} />
          </div>
        )}

        {doc && kind && (
          <>
            <div className="flex items-start gap-3 border-b py-4 pl-5 pr-16 sm:pl-6">
              <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl", kind.tile)}>
                <kind.Icon className="size-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                {renaming ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void commitRename();
                    }}
                  >
                    <Input
                      autoFocus
                      value={draft}
                      aria-label="File name"
                      aria-invalid={!!renameError}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        setRenameError("");
                      }}
                      onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setRenaming(false))}
                      className="h-9"
                    />
                    <Button type="submit" size="icon-sm" aria-label="Save name">
                      <Check />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Cancel rename" onClick={() => setRenaming(false)}>
                      <X />
                    </Button>
                  </form>
                ) : (
                  <DialogTitle className="break-words text-base sm:text-lg">{doc.displayName}</DialogTitle>
                )}
                {renameError && (
                  <p role="alert" className="mt-1 text-xs text-destructive">
                    {renameError}
                  </p>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge variant="muted">{kind.label}</Badge>
                  <Badge>{CATEGORY_LABELS[doc.category]}</Badge>
                  {inTrash && <Badge variant="danger">In trash</Badge>}
                </div>
              </div>
              {!inTrash && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-pressed={doc.starred}
                  aria-label={doc.starred ? "Unstar document" : "Star document"}
                  disabled={!canEdit}
                  onClick={() => manager.toggleStar(doc)}
                >
                  <Star className={cn("size-5", doc.starred && "fill-amber-400 text-amber-500")} />
                </Button>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_340px]">
                <div className="flex min-w-0 flex-col gap-4">
                  <DocumentPreview api={api} doc={doc} onDownload={() => manager.download(doc)} />
                  <div className="flex flex-wrap gap-2">
                    {inTrash ? (
                      <>
                        {perms.delete && (
                          <Button variant="outline" onClick={() => manager.restore(doc)}>
                            <Undo2 /> Restore
                          </Button>
                        )}
                        {perms.purge && (
                          <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
                            <Trash2 /> Delete permanently
                          </Button>
                        )}
                      </>
                    ) : (
                      <>
                        <Button variant="gradient" onClick={() => manager.download(doc)}>
                          <Download /> Download
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => setSharing(true)}
                          disabled={!perms.share || !api.capabilities.share}
                          title={!api.capabilities.share ? "Share links need a connected workspace" : undefined}
                        >
                          <Share2 /> Share
                        </Button>
                        <Button variant="outline" onClick={startRename} disabled={!canEdit}>
                          <Pencil /> Rename
                        </Button>
                        {canEdit && api.mode !== "demo" && (
                          <Button variant="outline" onClick={() => versionInput.current?.click()}>
                            <Upload /> New version
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          className="ml-auto text-destructive hover:bg-red-50"
                          disabled={!perms.delete}
                          onClick={() => setConfirmDelete(true)}
                        >
                          <Trash2 /> Delete
                        </Button>
                      </>
                    )}
                  </div>
                  {!api.capabilities.share && !inTrash && (
                    <p className="text-xs text-muted-foreground">Share links are available in a connected workspace.</p>
                  )}
                  <input
                    ref={versionInput}
                    type="file"
                    className="sr-only"
                    tabIndex={-1}
                    aria-label="Upload new version"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) await onUploadVersion(doc.id, f);
                    }}
                  />
                </div>

                <div className="space-y-5">
                  <section aria-labelledby="tags-heading">
                    <h4 id="tags-heading" className="mb-2 text-sm font-semibold">
                      Tags
                    </h4>
                    <TagEditor
                      tags={doc.tags}
                      suggestions={boot?.tags ?? []}
                      readOnly={!canEdit}
                      onChange={(tags) => manager.update(doc.id, { tags })}
                    />
                  </section>
                  <DocumentMetadata
                    doc={doc}
                    folders={boot?.folders ?? []}
                    canEdit={canEdit}
                    onMove={(folderId) => {
                      const target = boot?.folders.find((f) => f.id === folderId)?.name ?? "no folder";
                      void manager.update(doc.id, { folderId }, `Moved to ${target}.`);
                    }}
                    onCategory={(category) => void manager.update(doc.id, { category }, "Category updated.")}
                    onExpiry={(expiresAt) => void manager.update(doc.id, { expiresAt })}
                    onDownloadVersion={(v) => manager.download(doc, v.versionNumber)}
                  />
                </div>
              </div>
            </div>

            <ShareDialog
              open={sharing}
              fileName={doc.displayName}
              onOpenChange={setSharing}
              onCreate={(ttl) => api.createShareLink(doc.id, ttl)}
              loadLinks={() => api.listShareLinks(doc.id)}
              onRevoke={(linkId) => api.revokeShareLink(doc.id, linkId)}
            />
            <DeleteConfirmationDialog
              open={confirmDelete}
              onOpenChange={setConfirmDelete}
              title={inTrash ? "Delete permanently?" : `Delete “${doc.displayName}”?`}
              description={
                inTrash
                  ? "This removes the file and all of its versions for good. This cannot be undone."
                  : "It moves to Trash and can be restored from there. Storage is freed when you delete it permanently."
              }
              confirmLabel={inTrash ? "Delete permanently" : "Move to trash"}
              onConfirm={() => manager.remove(doc, inTrash)}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
