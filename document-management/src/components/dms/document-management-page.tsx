"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FlaskConical, Info } from "lucide-react";
import type { DmsApi } from "@/lib/dms/client/api";
import { toDmsError } from "@/lib/dms/errors";
import { DashboardHeader } from "./dashboard-header";
import { DocumentDetailsPanel } from "./document-details-panel";
import { DocumentGrid } from "./document-grid";
import { DocumentToolbar } from "./document-toolbar";
import { FolderGrid } from "./folder-grid";
import { EmptyState, ErrorState, LoadingSkeleton } from "./states";
import { Toaster } from "./toaster";
import { UploadDialog } from "./upload-dialog";
import { useDocumentManager } from "./use-document-manager";

const MODE_NOTICE: Record<DmsApi["mode"], string | null> = {
  demo: "Demo workspace with sample data. Changes stay in this browser tab and are not saved or uploaded anywhere.",
  dev: "Development mode: data is held in server memory and is not persisted. Configure Supabase to use a real database.",
  live: null,
};

/** The whole workspace UI. Data access is injected through `api`; this component owns no I/O. */
export function DocumentManagementPage({ api }: { api: DmsApi }) {
  const m = useDocumentManager(api);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFolder, setUploadFolder] = useState<string | null>(null);

  const openUpload = () => {
    setUploadFolder(m.query.folderId);
    setUploadOpen(true);
  };

  // Several uploads finishing together should trigger one refresh.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { reload } = m;
  const onUploaded = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void reload(), 250);
  }, [reload]);
  useEffect(() => () => void (refreshTimer.current && clearTimeout(refreshTimer.current)), []);

  const uploadVersion = useCallback(
    async (documentId: string, file: File) => {
      const target = m.detail;
      try {
        await api.uploadFile({ file, documentId, folderId: target?.folderId ?? null });
        m.notify("success", "New version uploaded.");
        await Promise.all([m.reloadDetail(), m.reload()]);
      } catch (e) {
        m.notify("error", toDmsError(e).message);
      }
    },
    [api, m],
  );

  const notice = MODE_NOTICE[api.mode];
  const { boot, query } = m;
  const filtered = Boolean(query.search || query.category || query.fileType || query.tag);

  let emptyVariant: Parameters<typeof EmptyState>[0]["variant"] = "all";
  if (filtered) emptyVariant = "search";
  else if (query.view !== "all") emptyVariant = query.view;
  else if (query.folderId) emptyVariant = "folder";

  return (
    <div className="rounded-2xl border bg-card shadow-panel" data-testid="workspace">
      {notice && (
        <div
          role="note"
          className="flex items-start gap-2.5 rounded-t-2xl border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-xs text-amber-900 sm:px-8"
        >
          {api.mode === "demo" ? <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <FlaskConical className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
          <p>{notice}</p>
        </div>
      )}

      <div className="space-y-7 p-5 sm:p-8">
        {m.bootState === "error" ? (
          <ErrorState title="Could not load your workspace" message={m.bootError} onRetry={m.retryBootstrap} />
        ) : (
          <>
            <DashboardHeader usage={boot?.usage ?? null} canUpload={m.perms.write && !!boot} onUpload={openUpload} />

            <FolderGrid
              folders={boot?.folders ?? []}
              totalCount={boot?.usage.documentCount ?? 0}
              activeFolderId={query.folderId}
              canManage={m.perms.folders}
              loading={!boot}
              onSelect={(id) => m.patchQuery({ folderId: id, view: query.view === "trash" ? "all" : query.view })}
              onCreate={m.createFolder}
              onRename={m.renameFolder}
              onDelete={m.deleteFolder}
            />

            <section aria-labelledby="library-heading" className="space-y-4">
              <div className="flex items-baseline justify-between gap-3">
                <h3 id="library-heading" className="text-sm font-semibold">
                  {m.activeFolder ? m.activeFolder.name : query.view === "trash" ? "Trash" : "All documents"}
                </h3>
              </div>
              <DocumentToolbar
                query={query}
                tags={boot?.tags ?? []}
                trashCount={boot?.trashCount ?? 0}
                onChange={m.patchQuery}
              />

              {m.listState === "loading" && <LoadingSkeleton />}
              {m.listState === "error" && <ErrorState message={m.listError} onRetry={() => void m.reload({ meta: false })} />}
              {m.listState === "ready" && m.items.length === 0 && (
                <EmptyState
                  variant={emptyVariant}
                  onUpload={m.perms.write ? openUpload : undefined}
                  onClearFilters={() => m.patchQuery({ search: "", category: null, fileType: null, tag: null })}
                />
              )}
              {m.listState === "ready" && m.items.length > 0 && (
                <DocumentGrid
                  items={m.items}
                  total={m.total}
                  folders={boot?.folders ?? []}
                  inTrash={query.view === "trash"}
                  canEdit={m.perms.write}
                  hasMore={m.hasMore}
                  loadingMore={m.loadingMore}
                  onOpen={(id) => void m.openDocument(id)}
                  onToggleStar={m.toggleStar}
                  onRestore={m.restore}
                  onLoadMore={m.loadMore}
                />
              )}
            </section>
          </>
        )}
      </div>

      {boot && (
        <UploadDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          api={api}
          limits={boot.limits}
          folders={boot.folders}
          folderId={uploadFolder}
          onFolderChange={setUploadFolder}
          usage={boot.usage}
          onUploaded={onUploaded}
        />
      )}
      <DocumentDetailsPanel manager={m} onUploadVersion={uploadVersion} />
      <Toaster notices={m.notices} onDismiss={m.dismissNotice} />
    </div>
  );
}
