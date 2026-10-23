import { DmsError } from "../errors";
import { applyDocumentQuery } from "../query";
import type {
  AuditEntry,
  BeginUploadArgs,
  BeginUploadResult,
  DocumentPatch,
  DocumentRepository,
  ObjectStorage,
} from "../ports";
import type {
  DocumentQuery,
  DocumentRecord,
  DocumentVersion,
  FileLink,
  Folder,
  FolderColor,
  FolderWithCount,
  StorageUsage,
  UploadTarget,
  Workspace,
} from "../types";

type StoredVersion = DocumentVersion & { status: "pending" | "ready"; workspaceId: string };

export interface StoredAudit extends AuditEntry {
  id: string;
  workspaceId: string;
  actorId: string;
  createdAt: string;
}

export interface StoredShare {
  workspaceId: string;
  documentId: string;
  tokenHash: string;
  expiresAt: string;
  createdBy: string;
}

/** Plain data container so a store can be seeded, shared and inspected in tests. */
export class MemoryStore {
  workspaces = new Map<string, Workspace>();
  folders = new Map<string, Folder>();
  documents = new Map<string, DocumentRecord>();
  versions = new Map<string, StoredVersion[]>();
  /** documentId -> tag names */
  tags = new Map<string, string[]>();
  shares: StoredShare[] = [];
  audit: StoredAudit[] = [];
  blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();
}

export class MemoryRepository implements DocumentRepository {
  constructor(
    private readonly store: MemoryStore,
    private readonly opts: { newId?: () => string; now?: () => Date } = {},
  ) {}

  private id() {
    return (this.opts.newId ?? (() => globalThis.crypto.randomUUID()))();
  }
  private now() {
    return (this.opts.now ?? (() => new Date()))();
  }

  private doc(ws: string, id: string): DocumentRecord {
    const d = this.store.documents.get(id);
    if (!d || d.workspaceId !== ws) throw new DmsError("not_found", "Document not found.");
    return d;
  }

  async getWorkspace(workspaceId: string) {
    return this.store.workspaces.get(workspaceId) ?? null;
  }

  async listFolders(ws: string): Promise<FolderWithCount[]> {
    const counts = new Map<string, number>();
    for (const d of this.store.documents.values()) {
      if (d.workspaceId === ws && d.status === "ready" && !d.deletedAt && d.folderId) {
        counts.set(d.folderId, (counts.get(d.folderId) ?? 0) + 1);
      }
    }
    return [...this.store.folders.values()]
      .filter((f) => f.workspaceId === ws)
      .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.createdAt.localeCompare(b.createdAt))
      .map((f) => ({ ...f, documentCount: counts.get(f.id) ?? 0 }));
  }

  async getFolder(ws: string, id: string) {
    const f = this.store.folders.get(id);
    return f && f.workspaceId === ws ? f : null;
  }

  async createFolder(a: { workspaceId: string; name: string; color: FolderColor; userId: string }) {
    const folder: Folder = {
      id: this.id(),
      workspaceId: a.workspaceId,
      name: a.name,
      color: a.color,
      isSystem: false,
      defaultCategory: null,
      createdAt: this.now().toISOString(),
    };
    this.store.folders.set(folder.id, folder);
    return folder;
  }

  async renameFolder(ws: string, id: string, name: string) {
    const f = await this.getFolder(ws, id);
    if (!f) throw new DmsError("not_found", "Folder not found.");
    const next = { ...f, name };
    this.store.folders.set(id, next);
    return next;
  }

  async deleteFolder(ws: string, id: string) {
    const f = await this.getFolder(ws, id);
    if (!f) throw new DmsError("not_found", "Folder not found.");
    this.store.folders.delete(id);
    for (const [k, d] of this.store.documents) {
      if (d.workspaceId === ws && d.folderId === id) {
        this.store.documents.set(k, { ...d, folderId: null });
      }
    }
  }

  async listTags(ws: string) {
    const names = new Map<string, string>();
    for (const d of this.store.documents.values()) {
      if (d.workspaceId !== ws || d.deletedAt) continue;
      for (const t of d.tags) names.set(t.toLowerCase(), names.get(t.toLowerCase()) ?? t);
    }
    return [...names.values()].sort((a, b) => a.localeCompare(b));
  }

  async queryDocuments(ws: string, q: DocumentQuery) {
    const docs = [...this.store.documents.values()].filter((d) => d.workspaceId === ws);
    return applyDocumentQuery(docs, q, this.now());
  }

  async getDocument(ws: string, id: string) {
    const d = this.store.documents.get(id);
    return d && d.workspaceId === ws ? d : null;
  }

  async listVersions(ws: string, id: string): Promise<DocumentVersion[]> {
    this.doc(ws, id);
    return (this.store.versions.get(id) ?? [])
      .filter((v) => v.status === "ready")
      .map(stripVersion)
      .sort((a, b) => b.versionNumber - a.versionNumber);
  }

  private usedBytes(ws: string) {
    let used = 0;
    let count = 0;
    for (const vs of this.store.versions.values()) {
      for (const v of vs) if (v.workspaceId === ws) used += v.sizeBytes;
    }
    for (const d of this.store.documents.values()) {
      if (d.workspaceId === ws && d.status === "ready" && !d.deletedAt) count++;
    }
    return { used, count };
  }

  async beginUpload(a: BeginUploadArgs): Promise<BeginUploadResult> {
    const ws = this.store.workspaces.get(a.workspaceId);
    if (!ws) throw new DmsError("not_found", "Workspace not found.");
    const { used } = this.usedBytes(a.workspaceId);
    if (used + a.sizeBytes > ws.storageQuotaBytes) {
      throw new DmsError("quota_exceeded", "Not enough storage left in this workspace.");
    }
    const nowIso = this.now().toISOString();
    let document: DocumentRecord;
    let versionNumber = 1;
    if (a.documentId) {
      document = this.doc(a.workspaceId, a.documentId);
      const all = this.store.versions.get(document.id) ?? [];
      if (all.some((v) => v.status === "pending")) {
        throw new DmsError("conflict", "Another upload for this document is in progress.");
      }
      versionNumber = Math.max(...all.map((v) => v.versionNumber), 0) + 1;
    } else {
      document = {
        id: a.newDocumentId,
        workspaceId: a.workspaceId,
        folderId: a.folderId,
        originalName: a.originalName,
        displayName: a.displayName,
        storageKey: "",
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        category: a.category,
        tags: [],
        uploadedBy: a.userId,
        uploadedByName: a.userName,
        createdAt: nowIso,
        updatedAt: nowIso,
        expiresAt: null,
        starred: false,
        status: "pending",
        deletedAt: null,
        currentVersion: 0,
      };
      this.store.documents.set(document.id, document);
    }
    const version: StoredVersion = {
      id: this.id(),
      documentId: document.id,
      workspaceId: a.workspaceId,
      versionNumber,
      storageKey: a.storageKey(versionNumber),
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      createdBy: a.userId,
      createdByName: a.userName,
      createdAt: nowIso,
      status: "pending",
    };
    this.store.versions.set(document.id, [...(this.store.versions.get(document.id) ?? []), version]);
    return { document, version: stripVersion(version) };
  }

  async getVersion(ws: string, documentId: string, versionNumber: number) {
    const d = await this.getDocument(ws, documentId);
    if (!d) return null;
    const v = (this.store.versions.get(documentId) ?? []).find((x) => x.versionNumber === versionNumber);
    return v ? { ...stripVersion(v), status: v.status } : null;
  }

  async completeUpload(a: {
    workspaceId: string;
    documentId: string;
    versionNumber: number;
    sizeBytes: number;
    mimeType: string;
  }) {
    const d = this.doc(a.workspaceId, a.documentId);
    const vs = this.store.versions.get(d.id) ?? [];
    const v = vs.find((x) => x.versionNumber === a.versionNumber && x.status === "pending");
    if (!v) throw new DmsError("not_found", "Upload not found.");
    v.status = "ready";
    v.sizeBytes = a.sizeBytes;
    const next: DocumentRecord = {
      ...d,
      status: "ready",
      storageKey: v.storageKey,
      sizeBytes: a.sizeBytes,
      mimeType: a.mimeType,
      currentVersion: a.versionNumber,
      updatedAt: this.now().toISOString(),
    };
    this.store.documents.set(d.id, next);
    return next;
  }

  async abortUpload(ws: string, documentId: string, versionNumber: number) {
    const d = await this.getDocument(ws, documentId);
    if (!d) return null;
    const vs = this.store.versions.get(documentId) ?? [];
    const v = vs.find((x) => x.versionNumber === versionNumber && x.status === "pending");
    if (!v) return null;
    const rest = vs.filter((x) => x !== v);
    this.store.versions.set(documentId, rest);
    if (rest.length === 0) {
      this.store.documents.delete(documentId);
      this.store.versions.delete(documentId);
    }
    return v.storageKey;
  }

  async updateDocument(ws: string, id: string, patch: DocumentPatch) {
    const d = this.doc(ws, id);
    const next: DocumentRecord = { ...d, ...patch, updatedAt: this.now().toISOString() };
    this.store.documents.set(id, next);
    return next;
  }

  async setTags(ws: string, id: string, tags: string[]) {
    const d = this.doc(ws, id);
    this.store.documents.set(id, { ...d, tags: [...tags], updatedAt: this.now().toISOString() });
    return [...tags];
  }

  async softDelete(ws: string, id: string) {
    const d = this.doc(ws, id);
    const next = { ...d, deletedAt: this.now().toISOString() };
    this.store.documents.set(id, next);
    return next;
  }

  async restore(ws: string, id: string) {
    const d = this.doc(ws, id);
    const next = { ...d, deletedAt: null };
    this.store.documents.set(id, next);
    return next;
  }

  async purge(ws: string, id: string) {
    this.doc(ws, id);
    const keys = (this.store.versions.get(id) ?? []).map((v) => v.storageKey);
    this.store.documents.delete(id);
    this.store.versions.delete(id);
    return keys;
  }

  async getUsage(ws: string): Promise<StorageUsage> {
    const w = this.store.workspaces.get(ws);
    const { used, count } = this.usedBytes(ws);
    return { usedBytes: used, quotaBytes: w?.storageQuotaBytes ?? 0, documentCount: count };
  }

  async countTrash(ws: string) {
    let n = 0;
    for (const d of this.store.documents.values()) {
      if (d.workspaceId === ws && d.status === "ready" && d.deletedAt) n++;
    }
    return n;
  }

  async createShareLink(a: {
    workspaceId: string;
    documentId: string;
    tokenHash: string;
    expiresAt: string;
    userId: string;
  }) {
    this.doc(a.workspaceId, a.documentId);
    this.store.shares.push({
      workspaceId: a.workspaceId,
      documentId: a.documentId,
      tokenHash: a.tokenHash,
      expiresAt: a.expiresAt,
      createdBy: a.userId,
    });
  }

  async recordAudit(ws: string, userId: string, entry: AuditEntry) {
    this.store.audit.push({
      ...entry,
      id: this.id(),
      workspaceId: ws,
      actorId: userId,
      createdAt: this.now().toISOString(),
    });
  }
}

function stripVersion(v: StoredVersion): DocumentVersion {
  const { status: _s, workspaceId: _w, ...rest } = v;
  void _s;
  void _w;
  return rest;
}

/** In-memory object storage. Bytes never leave the process; "URLs" are blob: URLs in the browser. */
export class MemoryStorage implements ObjectStorage {
  constructor(
    private readonly store: MemoryStore,
    private readonly opts: {
      /** Builds an upload URL for the server-side dev route. Omit in the browser demo. */
      uploadUrl?: (key: string) => string;
      downloadUrl?: (key: string, o: { fileName: string; disposition: "inline" | "attachment"; ttlSeconds: number }) => string;
      /** Lets the demo synthesise bytes for seeded sample records. */
      synthesize?: (key: string) => { bytes: Uint8Array; mimeType: string } | null;
    } = {},
  ) {}

  async createUploadTarget(key: string, o: { mimeType: string; sizeBytes: number }): Promise<UploadTarget> {
    if (this.opts.uploadUrl) {
      return {
        kind: "put",
        url: this.opts.uploadUrl(key),
        method: "PUT",
        headers: { "content-type": o.mimeType },
      };
    }
    return { kind: "memory", url: key, method: "PUT", headers: {} };
  }

  put(key: string, bytes: Uint8Array, mimeType: string) {
    this.store.blobs.set(key, { bytes, mimeType });
  }

  private blob(key: string) {
    return this.store.blobs.get(key) ?? this.opts.synthesize?.(key) ?? null;
  }

  async stat(key: string) {
    const b = this.store.blobs.get(key);
    return b ? { sizeBytes: b.bytes.byteLength, mimeType: b.mimeType } : null;
  }

  async readHead(key: string, bytes: number) {
    const b = this.store.blobs.get(key);
    return b ? b.bytes.slice(0, bytes) : null;
  }

  async createDownloadUrl(
    key: string,
    o: { fileName: string; disposition: "inline" | "attachment"; ttlSeconds: number },
  ): Promise<FileLink> {
    const expiresAt = new Date(Date.now() + o.ttlSeconds * 1000).toISOString();
    if (this.opts.downloadUrl) {
      if (!this.blob(key)) throw new DmsError("not_found", "File content is not available.");
      return { url: this.opts.downloadUrl(key, o), expiresAt };
    }
    const blob = this.blob(key);
    if (!blob) {
      throw new DmsError("not_found", "This sample record has no file content in the demo.");
    }
    const copy = new Uint8Array(blob.bytes);
    return { url: URL.createObjectURL(new Blob([copy], { type: blob.mimeType })), expiresAt };
  }

  readBlob(key: string) {
    return this.blob(key);
  }

  async remove(keys: string[]) {
    for (const k of keys) this.store.blobs.delete(k);
  }
}
