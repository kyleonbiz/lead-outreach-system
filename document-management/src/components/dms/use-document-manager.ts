"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DmsApi, DocumentChanges } from "@/lib/dms/client/api";
import { toDmsError } from "@/lib/dms/errors";
import { can } from "@/lib/dms/service";
import { defaultQuery } from "@/lib/dms/validation";
import type {
  Bootstrap,
  DocumentDetail,
  DocumentQuery,
  DocumentRecord,
  FolderWithCount,
} from "@/lib/dms/types";

export interface Notice {
  id: number;
  kind: "success" | "error";
  message: string;
}

type LoadState = "loading" | "ready" | "error";

export function useDocumentManager(api: DmsApi) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootState, setBootState] = useState<LoadState>("loading");
  const [bootError, setBootError] = useState("");

  const [query, setQuery] = useState<DocumentQuery>(() => ({ ...defaultQuery(), pageSize: 12 }));
  const [items, setItems] = useState<DocumentRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [listState, setListState] = useState<LoadState>("loading");
  const [listError, setListError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [detailError, setDetailError] = useState("");

  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeId = useRef(0);
  const listSeq = useRef(0);
  const detailSeq = useRef(0);
  // The dialog is controlled (no Radix Trigger), so remember the opener to restore focus on close.
  const opener = useRef<HTMLElement | null>(null);

  const notify = useCallback((kind: Notice["kind"], message: string) => {
    const id = ++noticeId.current;
    setNotices((n) => [...n, { id, kind, message }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), kind === "error" ? 7000 : 4000);
  }, []);
  const dismissNotice = useCallback((id: number) => setNotices((n) => n.filter((x) => x.id !== id)), []);

  /* ---------------------------- bootstrap --------------------------- */

  const loadBootstrap = useCallback(async () => {
    try {
      const data = await api.bootstrap();
      setBoot(data);
      setBootState("ready");
    } catch (e) {
      setBootError(toDmsError(e).message);
      setBootState("error");
    }
  }, [api]);

  // Folder counts, tags, usage and trash count change after mutations.
  const refreshMeta = useCallback(async () => {
    try {
      setBoot(await api.bootstrap());
    } catch {
      /* keep the previous snapshot; the list surfaces real errors */
    }
  }, [api]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadBootstrap();
  }, [loadBootstrap]);

  /* ------------------------------ list ------------------------------ */

  const fetchPage = useCallback(
    async (q: DocumentQuery, append: boolean) => {
      const seq = ++listSeq.current;
      if (append) setLoadingMore(true);
      else setListState("loading");
      try {
        const page = await api.listDocuments(q);
        if (seq !== listSeq.current) return;
        setItems((prev) => (append ? [...prev, ...page.items.filter((i) => !prev.some((p) => p.id === i.id))] : page.items));
        setTotal(page.total);
        setListState("ready");
      } catch (e) {
        if (seq !== listSeq.current) return;
        if (append) notify("error", toDmsError(e).message);
        else {
          setListError(toDmsError(e).message);
          setListState("error");
        }
      } finally {
        if (seq === listSeq.current) setLoadingMore(false);
      }
    },
    [api, notify],
  );

  const filterKey = JSON.stringify({ ...query, page: 1 });
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchPage({ ...query, page: 1 }, false);
    // `query` is captured through filterKey; page resets to 1 on every filter change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, fetchPage]);

  const reload = useCallback(
    async (opts: { meta?: boolean } = { meta: true }) => {
      await Promise.all([fetchPage({ ...query, page: 1 }, false), opts.meta ? refreshMeta() : undefined]);
    },
    [fetchPage, query, refreshMeta],
  );

  const hasMore = items.length < total;
  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore) return;
    const next = { ...query, page: Math.floor(items.length / query.pageSize) + 1 };
    void fetchPage(next, true);
  }, [hasMore, loadingMore, query, items.length, fetchPage]);

  const patchQuery = useCallback((patch: Partial<DocumentQuery>) => {
    setQuery((q) => ({ ...q, ...patch, page: 1 }));
  }, []);

  /* ----------------------------- details ---------------------------- */

  const openDocument = useCallback(
    async (id: string | null) => {
      if (id && document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
      setSelectedId(id);
      setDetail(null);
      setDetailError("");
      if (!id) return;
      const seq = ++detailSeq.current;
      try {
        const d = await api.getDocument(id);
        if (seq === detailSeq.current) setDetail(d);
      } catch (e) {
        if (seq === detailSeq.current) setDetailError(toDmsError(e).message);
      }
    },
    [api],
  );

  const reloadDetail = useCallback(async () => {
    if (!selectedId) return;
    try {
      setDetail(await api.getDocument(selectedId));
    } catch {
      /* leave the stale panel; the action that triggered this already reported */
    }
  }, [api, selectedId]);

  /* ---------------------------- mutations --------------------------- */

  const applyLocal = useCallback((doc: DocumentRecord) => {
    setItems((list) => list.map((d) => (d.id === doc.id ? { ...d, ...doc } : d)));
    setDetail((d) => (d && d.id === doc.id ? { ...d, ...doc } : d));
  }, []);

  const update = useCallback(
    async (id: string, changes: DocumentChanges, success?: string) => {
      try {
        const doc = await api.updateDocument(id, changes);
        applyLocal(doc);
        if (success) notify("success", success);
        if (changes.folderId !== undefined || changes.tags !== undefined) void reload({ meta: true });
        // Moving out of the open folder view removes the card.
        if (changes.folderId !== undefined && query.folderId && changes.folderId !== query.folderId) {
          setItems((l) => l.filter((d) => d.id !== id));
        }
        return doc;
      } catch (e) {
        notify("error", toDmsError(e).message);
        return null;
      }
    },
    [api, applyLocal, notify, reload, query.folderId],
  );

  const toggleStar = useCallback(
    async (doc: DocumentRecord) => {
      const next = !doc.starred;
      applyLocal({ ...doc, starred: next });
      try {
        await api.updateDocument(doc.id, { starred: next });
        if (query.view === "starred" && !next) setItems((l) => l.filter((d) => d.id !== doc.id));
      } catch (e) {
        applyLocal(doc);
        notify("error", toDmsError(e).message);
      }
    },
    [api, applyLocal, notify, query.view],
  );

  const remove = useCallback(
    async (doc: DocumentRecord, permanent: boolean) => {
      try {
        if (permanent) await api.purgeDocument(doc.id);
        else await api.deleteDocument(doc.id);
        setItems((l) => l.filter((d) => d.id !== doc.id));
        setTotal((t) => Math.max(0, t - 1));
        if (selectedId === doc.id) void openDocument(null);
        notify("success", permanent ? "Deleted permanently." : "Moved to trash. You can restore it from Trash.");
        void refreshMeta();
        return true;
      } catch (e) {
        notify("error", toDmsError(e).message);
        return false;
      }
    },
    [api, notify, openDocument, refreshMeta, selectedId],
  );

  const restore = useCallback(
    async (doc: DocumentRecord) => {
      try {
        await api.restoreDocument(doc.id);
        setItems((l) => l.filter((d) => d.id !== doc.id));
        setTotal((t) => Math.max(0, t - 1));
        if (selectedId === doc.id) void openDocument(null);
        notify("success", `Restored “${doc.displayName}”.`);
        void refreshMeta();
      } catch (e) {
        notify("error", toDmsError(e).message);
      }
    },
    [api, notify, openDocument, refreshMeta, selectedId],
  );

  const download = useCallback(
    async (doc: DocumentRecord, versionNumber?: number) => {
      try {
        const link = await api.getFileLink(doc.id, { versionNumber, disposition: "attachment" });
        const a = document.createElement("a");
        a.href = link.url;
        a.download = doc.displayName;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (e) {
        notify("error", toDmsError(e).message);
      }
    },
    [api, notify],
  );

  /* ----------------------------- folders ---------------------------- */

  const createFolder = useCallback(
    async (name: string) => {
      try {
        const folder = await api.createFolder(name);
        notify("success", `Created folder “${folder.name}”.`);
        await refreshMeta();
        return folder;
      } catch (e) {
        notify("error", toDmsError(e).message);
        throw e;
      }
    },
    [api, notify, refreshMeta],
  );

  const renameFolder = useCallback(
    async (id: string, name: string) => {
      try {
        await api.renameFolder(id, name);
        notify("success", "Folder renamed.");
        await refreshMeta();
      } catch (e) {
        notify("error", toDmsError(e).message);
        throw e;
      }
    },
    [api, notify, refreshMeta],
  );

  const deleteFolder = useCallback(
    async (folder: FolderWithCount) => {
      try {
        await api.deleteFolder(folder.id);
        notify("success", `Deleted folder “${folder.name}”. Its documents are still in All Files.`);
        if (query.folderId === folder.id) patchQuery({ folderId: null });
        await Promise.all([refreshMeta(), fetchPage({ ...query, folderId: query.folderId === folder.id ? null : query.folderId, page: 1 }, false)]);
      } catch (e) {
        notify("error", toDmsError(e).message);
      }
    },
    [api, fetchPage, notify, patchQuery, query, refreshMeta],
  );

  /* ----------------------------- derived ---------------------------- */

  const perms = useMemo(() => {
    const role = boot?.role ?? "viewer";
    return {
      write: can(role, "write"),
      delete: can(role, "delete"),
      share: can(role, "share"),
      folders: can(role, "manage_folders"),
      purge: can(role, "purge"),
    };
  }, [boot?.role]);

  const activeFolder = boot?.folders.find((f) => f.id === query.folderId) ?? null;

  return {
    api,
    boot,
    bootState,
    bootError,
    retryBootstrap: loadBootstrap,
    query,
    patchQuery,
    items,
    total,
    listState,
    listError,
    loadingMore,
    hasMore,
    loadMore,
    reload,
    selectedId,
    detail,
    detailError,
    openDocument,
    restoreFocus: () => opener.current?.isConnected && opener.current.focus(),
    reloadDetail,
    update,
    toggleStar,
    remove,
    restore,
    download,
    createFolder,
    renameFolder,
    deleteFolder,
    perms,
    activeFolder,
    notices,
    notify,
    dismissNotice,
    refreshMeta,
  };
}

export type DocumentManager = ReturnType<typeof useDocumentManager>;
