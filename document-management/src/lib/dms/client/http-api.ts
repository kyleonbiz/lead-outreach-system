import { DmsError, type DmsErrorCode } from "../errors";
import type { ApiMode, DmsApi, DocumentChanges, UploadArgs } from "./api";
import type {
  Bootstrap,
  DocumentDetail,
  DocumentPage,
  DocumentQuery,
  DocumentRecord,
  FileLink,
  Folder,
  InitiateUploadResult,
  UploadTarget,
} from "../types";

type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: DmsErrorCode; message: string } };

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/dms${path}`, {
      method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
      headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      signal: init?.signal,
    });
  } catch {
    throw new DmsError("unavailable", "Network error. Check your connection and try again.");
  }
  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    /* non-JSON error page */
  }
  if (!body) throw new DmsError(res.ok ? "internal" : "unavailable", "Unexpected server response.");
  if (!body.ok) throw new DmsError(body.error.code, body.error.message);
  return body.data;
}

function queryString(q: DocumentQuery): string {
  const p = new URLSearchParams();
  p.set("view", q.view);
  if (q.folderId) p.set("folderId", q.folderId);
  if (q.search) p.set("search", q.search);
  if (q.category) p.set("category", q.category);
  if (q.fileType) p.set("fileType", q.fileType);
  if (q.tag) p.set("tag", q.tag);
  p.set("sort", q.sort);
  p.set("page", String(q.page));
  p.set("pageSize", String(q.pageSize));
  return p.toString();
}

/** Streams the file to storage with real progress events and abort support. */
export function xhrUpload(
  target: UploadTarget,
  file: File,
  opts: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, target.url);
    let body: XMLHttpRequestBodyInit = file;
    if (target.kind === "supabase-signed") {
      // Matches supabase-js `uploadToSignedUrl`: multipart with an unnamed file part.
      const form = new FormData();
      form.append("cacheControl", "3600");
      form.append("", file);
      body = form;
    } else {
      for (const [k, v] of Object.entries(target.headers)) xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        opts.onProgress?.(file.size, file.size);
        resolve();
      } else {
        reject(new DmsError("storage_failed", `Upload failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new DmsError("unavailable", "Network error during upload."));
    xhr.onabort = () => reject(new DmsError("conflict", "Upload cancelled."));
    const abort = () => xhr.abort();
    if (opts.signal) {
      if (opts.signal.aborted) return reject(new DmsError("conflict", "Upload cancelled."));
      opts.signal.addEventListener("abort", abort, { once: true });
    }
    xhr.send(body);
  });
}

export function createHttpApi(mode: Exclude<ApiMode, "demo">): DmsApi {
  return {
    mode,
    capabilities: { share: true },
    bootstrap: () => call<Bootstrap>("/bootstrap"),
    listDocuments: (q) => call<DocumentPage>(`/documents?${queryString(q)}`),
    getDocument: (id) => call<DocumentDetail>(`/documents/${id}`),
    updateDocument: (id, changes: DocumentChanges) =>
      call<DocumentRecord>(`/documents/${id}`, { method: "PATCH", json: changes }),
    deleteDocument: (id) => call<void>(`/documents/${id}`, { method: "DELETE" }),
    restoreDocument: (id) => call<DocumentRecord>(`/documents/${id}/restore`, { method: "POST", json: {} }),
    purgeDocument: (id) => call<void>(`/documents/${id}/purge`, { method: "POST", json: {} }),
    getFileLink: (id, opts) => {
      const p = new URLSearchParams();
      if (opts?.versionNumber) p.set("version", String(opts.versionNumber));
      if (opts?.disposition) p.set("disposition", opts.disposition);
      return call<FileLink>(`/documents/${id}/file?${p}`);
    },
    createShareLink: (id, ttlMinutes) =>
      call<{ url: string; expiresAt: string }>(`/documents/${id}/share`, { json: { ttlMinutes } }),
    createFolder: (name) => call<Folder>("/folders", { json: { name } }),
    renameFolder: (id, name) => call<Folder>(`/folders/${id}`, { method: "PATCH", json: { name } }),
    deleteFolder: (id) => call<void>(`/folders/${id}`, { method: "DELETE" }),
    async uploadFile(args: UploadArgs) {
      const init = await call<InitiateUploadResult>("/uploads", {
        json: {
          fileName: args.file.name,
          size: args.file.size,
          mimeType: args.file.type,
          folderId: args.folderId,
          category: args.category,
          documentId: args.documentId,
        },
        signal: args.signal,
      });
      try {
        await xhrUpload(init.target, args.file, { onProgress: args.onProgress, signal: args.signal });
        return await call<DocumentRecord>(`/uploads/${init.documentId}/finalize`, {
          json: { versionNumber: init.versionNumber },
        });
      } catch (e) {
        // Compensating action: drop the pending record and any partial object.
        await call<void>(`/uploads/${init.documentId}?version=${init.versionNumber}`, {
          method: "DELETE",
        }).catch(() => undefined);
        throw e;
      }
    },
  };
}
