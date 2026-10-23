import { DmsError } from "./errors";
import {
  DEFAULT_PAGE_SIZE,
  SHARE_LINK_MAX_MINUTES,
  SIGNED_URL_TTL_SECONDS,
} from "./config";
import type {
  DmsContext,
  DocumentPatch,
  DocumentRepository,
  ObjectStorage,
} from "./ports";
import type {
  Bootstrap,
  Category,
  DocumentDetail,
  DocumentPage,
  DocumentQuery,
  DocumentRecord,
  FileLink,
  Folder,
  InitiateUploadResult,
  Role,
  UploadLimits,
} from "./types";
import {
  buildStorageKey,
  categoryForFolderName,
  createFolderSchema,
  documentQuerySchema,
  getExtension,
  initiateUploadSchema,
  magicBytesMatch,
  normalizeRename,
  renameFolderSchema,
  updateDocumentSchema,
  validateUploadCandidate,
  workspaceOfKey,
  type UpdateDocumentInput,
} from "./validation";

type Action =
  | "read"
  | "write"
  | "delete"
  | "share"
  | "manage_folders"
  | "purge";

const MIN_ROLE: Record<Action, Role> = {
  read: "viewer",
  write: "editor",
  delete: "editor",
  share: "editor",
  manage_folders: "editor",
  purge: "admin",
};
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export function can(role: Role, action: Action): boolean {
  return RANK[role] >= RANK[MIN_ROLE[action]];
}

export interface ServiceDeps {
  repo: DocumentRepository;
  storage: ObjectStorage;
  limits: UploadLimits;
  ctx: DmsContext;
  userEmail?: string;
  newId?: () => string;
  nonce?: () => string;
  now?: () => Date;
}

const defaultId = () => globalThis.crypto.randomUUID();

/**
 * All document-management business rules live here. UI components and route
 * handlers call this; this calls the repository/storage ports.
 */
export class DocumentService {
  private readonly repo: DocumentRepository;
  private readonly storage: ObjectStorage;
  private readonly limits: UploadLimits;
  private readonly ctx: DmsContext;
  private readonly email: string;
  private readonly newId: () => string;
  private readonly nonce: () => string;
  private readonly now: () => Date;

  constructor(deps: ServiceDeps) {
    this.repo = deps.repo;
    this.storage = deps.storage;
    this.limits = deps.limits;
    this.ctx = deps.ctx;
    this.email = deps.userEmail ?? "";
    this.newId = deps.newId ?? defaultId;
    this.nonce = deps.nonce ?? (() => defaultId().replace(/-/g, "").slice(0, 16));
    this.now = deps.now ?? (() => new Date());
  }

  /* ----------------------------- guards ----------------------------- */

  private require(action: Action) {
    if (!can(this.ctx.role, action)) {
      throw new DmsError("forbidden", "You do not have permission to do that.");
    }
  }

  /** Loads a document scoped to the caller's workspace; foreign ids look like "not found". */
  private async loadDocument(id: string, opts: { allowDeleted?: boolean } = {}) {
    const doc = await this.repo.getDocument(this.ctx.workspaceId, id);
    if (!doc || doc.status !== "ready" || (doc.deletedAt && !opts.allowDeleted)) {
      throw new DmsError("not_found", "Document not found.");
    }
    return doc;
  }

  private audit(
    action: string,
    entityType: "document" | "folder" | "workspace",
    entityId: string | null,
    metadata?: Record<string, string | number | boolean | null>,
  ) {
    return this.repo.recordAudit(this.ctx.workspaceId, this.ctx.userId, {
      action,
      entityType,
      entityId,
      metadata,
    });
  }

  /* ---------------------------- bootstrap --------------------------- */

  async bootstrap(): Promise<Bootstrap> {
    this.require("read");
    const [workspace, folders, tags, usage, trashCount] = await Promise.all([
      this.repo.getWorkspace(this.ctx.workspaceId),
      this.repo.listFolders(this.ctx.workspaceId),
      this.repo.listTags(this.ctx.workspaceId),
      this.repo.getUsage(this.ctx.workspaceId),
      this.repo.countTrash(this.ctx.workspaceId),
    ]);
    if (!workspace) throw new DmsError("not_found", "Workspace not found.");
    return {
      workspace,
      role: this.ctx.role,
      user: { id: this.ctx.userId, name: this.ctx.userName, email: this.email },
      folders,
      tags,
      usage,
      trashCount,
      limits: this.limits,
    };
  }

  async getUsage() {
    this.require("read");
    return this.repo.getUsage(this.ctx.workspaceId);
  }

  /* ----------------------------- queries ---------------------------- */

  async listDocuments(input: Partial<DocumentQuery>): Promise<DocumentPage> {
    this.require("read");
    const query = documentQuerySchema.parse({
      ...input,
      pageSize: input.pageSize ?? DEFAULT_PAGE_SIZE,
    });
    if (query.folderId) {
      const folder = await this.repo.getFolder(this.ctx.workspaceId, query.folderId);
      if (!folder) throw new DmsError("not_found", "Folder not found.");
    }
    const { items, total } = await this.repo.queryDocuments(this.ctx.workspaceId, query);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async getDocument(id: string): Promise<DocumentDetail> {
    this.require("read");
    const doc = await this.loadDocument(id, { allowDeleted: true });
    const versions = await this.repo.listVersions(this.ctx.workspaceId, id);
    return { ...doc, versions };
  }

  /* ----------------------------- uploads ---------------------------- */

  async initiateUpload(raw: unknown): Promise<InitiateUploadResult> {
    this.require("write");
    const input = initiateUploadSchema.parse(raw);
    const check = validateUploadCandidate(
      { name: input.fileName, size: input.size, type: input.mimeType },
      this.limits,
    );
    if (!check.ok) throw new DmsError("validation", check.reason);

    let folderId = input.folderId;
    let category: Category = input.category ?? "other";
    let displayName = check.displayName;
    let existing: DocumentRecord | null = null;

    if (input.documentId) {
      existing = await this.loadDocument(input.documentId);
      if (getExtension(existing.originalName) !== check.extension) {
        throw new DmsError(
          "validation",
          `A new version must also be a .${getExtension(existing.originalName)} file.`,
        );
      }
      folderId = existing.folderId;
      category = existing.category;
      displayName = existing.displayName;
    } else if (folderId) {
      const folder = await this.repo.getFolder(this.ctx.workspaceId, folderId);
      if (!folder) throw new DmsError("not_found", "Folder not found.");
      if (!input.category && folder.defaultCategory) category = folder.defaultCategory;
    }

    const documentId = existing?.id ?? this.newId();
    const nonce = this.nonce();
    const { document, version } = await this.repo.beginUpload({
      workspaceId: this.ctx.workspaceId,
      userId: this.ctx.userId,
      userName: this.ctx.userName,
      documentId: existing?.id ?? null,
      newDocumentId: documentId,
      originalName: check.displayName,
      displayName,
      folderId,
      category,
      mimeType: check.mimeType,
      sizeBytes: input.size,
      storageKey: (versionNumber) =>
        buildStorageKey({
          workspaceId: this.ctx.workspaceId,
          documentId,
          versionNumber,
          extension: check.extension,
          nonce,
        }),
    });

    try {
      const target = await this.storage.createUploadTarget(version.storageKey, {
        mimeType: check.mimeType,
        sizeBytes: input.size,
      });
      return { documentId: document.id, versionNumber: version.versionNumber, target };
    } catch (e) {
      await this.repo.abortUpload(this.ctx.workspaceId, document.id, version.versionNumber);
      throw e instanceof DmsError
        ? e
        : new DmsError("storage_failed", "Could not prepare the upload.");
    }
  }

  async finalizeUpload(documentId: string, versionNumber: number): Promise<DocumentRecord> {
    this.require("write");
    const ws = this.ctx.workspaceId;
    const version = await this.repo.getVersion(ws, documentId, versionNumber);
    if (!version || version.status !== "pending") {
      throw new DmsError("not_found", "Upload not found.");
    }
    if (version.createdBy !== this.ctx.userId && !can(this.ctx.role, "purge")) {
      throw new DmsError("forbidden", "You cannot finish another user's upload.");
    }
    if (workspaceOfKey(version.storageKey) !== ws) {
      throw new DmsError("internal", "Stored key does not belong to this workspace.");
    }

    const fail = async (message: string, code: "validation" | "storage_failed") => {
      const key = await this.repo.abortUpload(ws, documentId, versionNumber);
      await this.storage.remove([key ?? version.storageKey]).catch(() => undefined);
      throw new DmsError(code, message);
    };

    const stat = await this.storage.stat(version.storageKey);
    if (!stat) return fail("The uploaded file was not found in storage.", "storage_failed");
    if (stat.sizeBytes !== version.sizeBytes) {
      return fail("The uploaded file size did not match what was declared.", "validation");
    }
    if (stat.sizeBytes > this.limits.maxFileSizeBytes) {
      return fail("The uploaded file exceeds the size limit.", "validation");
    }

    const head = await this.storage.readHead(version.storageKey, 16);
    if (head && !magicBytesMatch(getExtension(version.storageKey), head)) {
      return fail("The file contents do not match its extension.", "validation");
    }

    const doc = await this.repo.completeUpload({
      workspaceId: ws,
      documentId,
      versionNumber,
      sizeBytes: stat.sizeBytes,
      mimeType: version.mimeType,
    });
    await this.audit(
      versionNumber > 1 ? "document.version_uploaded" : "document.uploaded",
      "document",
      documentId,
      { name: doc.displayName, sizeBytes: doc.sizeBytes, version: versionNumber },
    );
    return doc;
  }

  async abortUpload(documentId: string, versionNumber: number): Promise<void> {
    this.require("write");
    const version = await this.repo.getVersion(this.ctx.workspaceId, documentId, versionNumber);
    if (!version || version.status !== "pending") return;
    if (version.createdBy !== this.ctx.userId && !can(this.ctx.role, "purge")) {
      throw new DmsError("forbidden", "You cannot cancel another user's upload.");
    }
    const key = await this.repo.abortUpload(this.ctx.workspaceId, documentId, versionNumber);
    if (key) await this.storage.remove([key]).catch(() => undefined);
  }

  /* ------------------------ document mutations ---------------------- */

  async updateDocument(id: string, raw: unknown): Promise<DocumentRecord> {
    this.require("write");
    const input: UpdateDocumentInput = updateDocumentSchema.parse(raw);
    const before = await this.loadDocument(id);
    const patch: DocumentPatch = {};

    if (input.displayName !== undefined) {
      const name = normalizeRename(input.displayName, before.originalName);
      if (!name) throw new DmsError("validation", "Enter a valid file name.");
      patch.displayName = name;
    }
    if (input.folderId !== undefined) {
      if (input.folderId !== null) {
        const folder = await this.repo.getFolder(this.ctx.workspaceId, input.folderId);
        if (!folder) throw new DmsError("not_found", "Folder not found.");
      }
      patch.folderId = input.folderId;
    }
    if (input.starred !== undefined) patch.starred = input.starred;
    if (input.category !== undefined) patch.category = input.category;
    if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt;

    let doc = before;
    if (Object.keys(patch).length > 0) {
      doc = await this.repo.updateDocument(this.ctx.workspaceId, id, patch);
    }
    if (input.tags !== undefined) {
      const tags = await this.repo.setTags(this.ctx.workspaceId, id, dedupeTags(input.tags), this.ctx.userId);
      doc = { ...doc, tags };
    }

    if (patch.displayName !== undefined) {
      await this.audit("document.renamed", "document", id, { from: before.displayName, to: patch.displayName });
    }
    if (patch.folderId !== undefined && patch.folderId !== before.folderId) {
      await this.audit("document.moved", "document", id, { to: patch.folderId });
    }
    if (patch.starred !== undefined && patch.starred !== before.starred) {
      await this.audit(patch.starred ? "document.starred" : "document.unstarred", "document", id);
    }
    if (input.tags !== undefined) await this.audit("document.tags_updated", "document", id);
    if (patch.category !== undefined && patch.category !== before.category) {
      await this.audit("document.category_changed", "document", id, { to: patch.category });
    }
    return doc;
  }

  async deleteDocument(id: string): Promise<void> {
    this.require("delete");
    await this.loadDocument(id);
    await this.repo.softDelete(this.ctx.workspaceId, id);
    await this.audit("document.deleted", "document", id);
  }

  async restoreDocument(id: string): Promise<DocumentRecord> {
    this.require("delete");
    const doc = await this.loadDocument(id, { allowDeleted: true });
    if (!doc.deletedAt) return doc;
    const restored = await this.repo.restore(this.ctx.workspaceId, id);
    await this.audit("document.restored", "document", id);
    return restored;
  }

  /** Permanently removes a trashed document and all of its stored versions. */
  async purgeDocument(id: string): Promise<void> {
    this.require("purge");
    const doc = await this.loadDocument(id, { allowDeleted: true });
    if (!doc.deletedAt) {
      throw new DmsError("conflict", "Move the document to trash before deleting it permanently.");
    }
    const keys = await this.repo.purge(this.ctx.workspaceId, id);
    // Metadata is already gone; a failed object delete leaves an orphan, never a dangling record.
    await this.storage.remove(keys).catch(() => undefined);
    await this.audit("document.purged", "document", id, { name: doc.displayName });
  }

  /* -------------------------- file access --------------------------- */

  async getFileLink(
    id: string,
    opts: { versionNumber?: number; disposition?: "inline" | "attachment" } = {},
  ): Promise<FileLink> {
    this.require("read");
    const doc = await this.loadDocument(id);
    const versionNumber = opts.versionNumber ?? doc.currentVersion;
    const version = await this.repo.getVersion(this.ctx.workspaceId, id, versionNumber);
    if (!version || version.status !== "ready") {
      throw new DmsError("not_found", "Version not found.");
    }
    if (workspaceOfKey(version.storageKey) !== this.ctx.workspaceId) {
      throw new DmsError("forbidden", "File does not belong to this workspace.");
    }
    const disposition = opts.disposition ?? "attachment";
    const link = await this.storage.createDownloadUrl(version.storageKey, {
      fileName: doc.displayName,
      disposition,
      ttlSeconds: SIGNED_URL_TTL_SECONDS,
    });
    if (disposition === "attachment") {
      await this.audit("document.downloaded", "document", id, { version: versionNumber });
    }
    return link;
  }

  async createShareLink(
    id: string,
    ttlMinutes: number,
  ): Promise<{ token: string; expiresAt: string }> {
    this.require("share");
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > SHARE_LINK_MAX_MINUTES) {
      throw new DmsError("validation", "Choose a link lifetime between 5 minutes and 7 days.");
    }
    await this.loadDocument(id);
    const token = randomToken();
    const expiresAt = new Date(this.now().getTime() + ttlMinutes * 60_000).toISOString();
    await this.repo.createShareLink({
      workspaceId: this.ctx.workspaceId,
      documentId: id,
      tokenHash: await sha256Hex(token),
      expiresAt,
      userId: this.ctx.userId,
    });
    await this.audit("document.shared", "document", id, { ttlMinutes });
    return { token, expiresAt };
  }

  /* ----------------------------- folders ---------------------------- */

  async createFolder(raw: unknown): Promise<Folder> {
    this.require("manage_folders");
    const input = createFolderSchema.parse(raw);
    const existing = await this.repo.listFolders(this.ctx.workspaceId);
    if (existing.some((f) => f.name.toLowerCase() === input.name.toLowerCase())) {
      throw new DmsError("conflict", "A folder with that name already exists.");
    }
    const palette = ["violet", "blue", "emerald", "amber", "rose", "sky", "orange"] as const;
    const color = input.color ?? palette[existing.length % palette.length];
    const folder = await this.repo.createFolder({
      workspaceId: this.ctx.workspaceId,
      name: input.name,
      color,
      userId: this.ctx.userId,
    });
    await this.audit("folder.created", "folder", folder.id, { name: folder.name });
    return folder;
  }

  async renameFolder(id: string, raw: unknown): Promise<Folder> {
    this.require("manage_folders");
    const { name } = renameFolderSchema.parse(raw);
    const folder = await this.repo.getFolder(this.ctx.workspaceId, id);
    if (!folder) throw new DmsError("not_found", "Folder not found.");
    if (folder.isSystem) throw new DmsError("forbidden", "Built-in folders cannot be renamed.");
    const existing = await this.repo.listFolders(this.ctx.workspaceId);
    if (existing.some((f) => f.id !== id && f.name.toLowerCase() === name.toLowerCase())) {
      throw new DmsError("conflict", "A folder with that name already exists.");
    }
    const updated = await this.repo.renameFolder(this.ctx.workspaceId, id, name);
    await this.audit("folder.renamed", "folder", id, { from: folder.name, to: name });
    return updated;
  }

  /** Deleting a folder keeps its documents; they move to "All Files" (no folder). */
  async deleteFolder(id: string): Promise<void> {
    this.require("manage_folders");
    const folder = await this.repo.getFolder(this.ctx.workspaceId, id);
    if (!folder) throw new DmsError("not_found", "Folder not found.");
    if (folder.isSystem) throw new DmsError("forbidden", "Built-in folders cannot be deleted.");
    await this.repo.deleteFolder(this.ctx.workspaceId, id);
    await this.audit("folder.deleted", "folder", id, { name: folder.name });
  }
}

export function dedupeTags(tags: string[]): string[] {
  const seen = new Map<string, string>();
  for (const t of tags) {
    const clean = t.trim().replace(/\s+/g, " ");
    if (clean && !seen.has(clean.toLowerCase())) seen.set(clean.toLowerCase(), clean);
  }
  return [...seen.values()];
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { categoryForFolderName };
