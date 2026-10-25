"use client";

import { useRef, useState } from "react";
import { Check, Download, FolderInput, Pencil, Share2, Star, Trash2, Undo2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/lib/dms/validation";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import { DocumentMetadata, FileDetails, SectionLabel } from "./document-metadata";
import { FolderPicker } from "./folder-picker";
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
  const [moving, setMoving] = useState(false);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
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
        variant="details"
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
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                  <span>
                    {kind.noun} • {formatBytes(doc.sizeBytes)} • v{doc.currentVersion}.0
                  </span>
                  {inTrash && <Badge variant="danger">In trash</Badge>}
                </p>
              </div>
              {!inTrash && (
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button variant="ghost" size="icon-sm" aria-label="Download" onClick={() => manager.download(doc)}>
                    <Download />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Share"
                    onClick={() => setSharing(true)}
                    disabled={!perms.share || !api.capabilities.share}
                    title={!api.capabilities.share ? "Share links need a connected workspace" : undefined}
                  >
                    <Share2 />
                  </Button>
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:overflow-hidden">
              <div className="flex min-w-0 flex-col gap-4 p-5 sm:p-6 lg:overflow-y-auto">
                <DocumentPreview api={api} doc={doc} onDownload={() => manager.download(doc)} />
                {inTrash && (
                  <div className="flex flex-wrap gap-2">
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
                  </div>
                )}
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

              <aside className="space-y-6 border-t bg-slate-50/80 p-5 sm:p-6 lg:overflow-y-auto lg:border-l lg:border-t-0" aria-label="Document information">
                <FileDetails doc={doc} folders={boot?.folders ?? []} />

                <section aria-labelledby="tags-heading">
                  <SectionLabel id="tags-heading">Tags</SectionLabel>
                  <TagEditor
                    tags={doc.tags}
                    suggestions={boot?.tags ?? []}
                    readOnly={!canEdit}
                    onChange={(tags) => manager.update(doc.id, { tags })}
                  />
                </section>

                {!inTrash && (
                  <section aria-labelledby="actions-heading">
                    <SectionLabel id="actions-heading">Actions</SectionLabel>
                    <div className="space-y-1.5">
                      <ActionRow icon={Pencil} disabled={!canEdit} onClick={startRename}>
                        Rename
                      </ActionRow>
                      <ActionRow
                        icon={FolderInput}
                        disabled={!canEdit}
                        onClick={() => {
                          setMoveTarget(doc.folderId);
                          setMoving(true);
                        }}
                      >
                        Move to Folder
                      </ActionRow>
                      <ActionRow icon={Star} disabled={!canEdit} pressed={doc.starred} onClick={() => manager.toggleStar(doc)}>
                        {doc.starred ? "Unstar" : "Star"}
                      </ActionRow>
                      {canEdit && api.mode !== "demo" && (
                        <ActionRow icon={Upload} onClick={() => versionInput.current?.click()}>
                          New version
                        </ActionRow>
                      )}
                      <ActionRow icon={Trash2} danger disabled={!perms.delete} onClick={() => setConfirmDelete(true)}>
                        Delete File
                      </ActionRow>
                    </div>
                  </section>
                )}

                <DocumentMetadata
                  doc={doc}
                  canEdit={canEdit}
                  onCategory={(category) => void manager.update(doc.id, { category }, "Category updated.")}
                  onExpiry={(expiresAt) => void manager.update(doc.id, { expiresAt })}
                  onDownloadVersion={(v) => manager.download(doc, v.versionNumber)}
                />
              </aside>
            </div>

            <Dialog open={moving} onOpenChange={setMoving}>
              <DialogContent variant="alert">
                <DialogTitle>Move to folder</DialogTitle>
                <DialogDescription className="mt-1 break-words">Choose where “{doc.displayName}” should live.</DialogDescription>
                <div className="mt-4">
                  <FolderPicker folders={boot?.folders ?? []} value={moveTarget} onChange={setMoveTarget} noneLabel="No folder" ariaLabel="Destination folder" />
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setMoving(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={async () => {
                      const target = boot?.folders.find((f) => f.id === moveTarget)?.name ?? "no folder";
                      if (moveTarget !== doc.folderId) await manager.update(doc.id, { folderId: moveTarget }, `Moved to ${target}.`);
                      setMoving(false);
                    }}
                  >
                    Move
                  </Button>
                </div>
              </DialogContent>
            </Dialog>

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

function ActionRow({
  icon: Icon,
  children,
  danger,
  pressed,
  disabled,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  danger?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        danger ? "bg-red-50 text-destructive hover:bg-red-100" : "bg-white text-foreground shadow-[0_0_0_1px_rgb(228_230_240)] hover:bg-muted",
      )}
    >
      <Icon className={cn("size-4", pressed && "fill-amber-400 text-amber-500")} />
      {children}
    </button>
  );
}
