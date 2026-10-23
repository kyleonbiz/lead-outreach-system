import type {
  Category,
  DocumentQuery,
  DocumentRecord,
  DocumentVersion,
  FileLink,
  Folder,
  FolderColor,
  Invite,
  Member,
  ShareLinkInfo,
  FolderWithCount,
  Role,
  StorageUsage,
  UploadTarget,
  Workspace,
} from "./types";

export interface DmsContext {
  workspaceId: string;
  userId: string;
  userName: string;
  role: Role;
}

export interface AuditEntry {
  action: string;
  entityType: "document" | "folder" | "workspace";
  entityId: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface BeginUploadArgs {
  workspaceId: string;
  userId: string;
  userName: string;
  /** Present when adding a version to an existing document. */
  documentId: string | null;
  newDocumentId: string;
  originalName: string;
  displayName: string;
  folderId: string | null;
  category: Category;
  mimeType: string;
  sizeBytes: number;
  storageKey: (versionNumber: number) => string;
}

export interface BeginUploadResult {
  document: DocumentRecord;
  version: DocumentVersion;
}

export interface DocumentPatch {
  displayName?: string;
  folderId?: string | null;
  starred?: boolean;
  category?: Category;
  expiresAt?: string | null;
}

/**
 * Persistence port. The Supabase adapter runs every call as the signed-in
 * user so Postgres RLS is the real tenant boundary; the service additionally
 * checks roles so behaviour is identical for the in-memory adapter.
 */
export interface DocumentRepository {
  getWorkspace(workspaceId: string): Promise<Workspace | null>;

  listFolders(workspaceId: string): Promise<FolderWithCount[]>;
  getFolder(workspaceId: string, folderId: string): Promise<Folder | null>;
  createFolder(args: {
    workspaceId: string;
    name: string;
    color: FolderColor;
    userId: string;
  }): Promise<Folder>;
  renameFolder(workspaceId: string, folderId: string, name: string): Promise<Folder>;
  deleteFolder(workspaceId: string, folderId: string): Promise<void>;

  listTags(workspaceId: string): Promise<string[]>;

  queryDocuments(
    workspaceId: string,
    query: DocumentQuery,
  ): Promise<{ items: DocumentRecord[]; total: number }>;
  getDocument(workspaceId: string, documentId: string): Promise<DocumentRecord | null>;
  listVersions(workspaceId: string, documentId: string): Promise<DocumentVersion[]>;

  /** Atomically enforces the workspace quota and records a pending document/version. */
  beginUpload(args: BeginUploadArgs): Promise<BeginUploadResult>;
  getVersion(
    workspaceId: string,
    documentId: string,
    versionNumber: number,
  ): Promise<(DocumentVersion & { status: "pending" | "ready" }) | null>;
  completeUpload(args: {
    workspaceId: string;
    documentId: string;
    versionNumber: number;
    sizeBytes: number;
    mimeType: string;
  }): Promise<DocumentRecord>;
  /** Removes a pending version (and its document if nothing else is stored). Returns the storage key to delete. */
  abortUpload(
    workspaceId: string,
    documentId: string,
    versionNumber: number,
  ): Promise<string | null>;

  updateDocument(
    workspaceId: string,
    documentId: string,
    patch: DocumentPatch,
  ): Promise<DocumentRecord>;
  setTags(workspaceId: string, documentId: string, tags: string[], userId: string): Promise<string[]>;
  softDelete(workspaceId: string, documentId: string): Promise<DocumentRecord>;
  restore(workspaceId: string, documentId: string): Promise<DocumentRecord>;
  /** Hard-deletes the document and all versions; returns every storage key to remove. */
  purge(workspaceId: string, documentId: string): Promise<string[]>;

  getUsage(workspaceId: string): Promise<StorageUsage>;
  countTrash(workspaceId: string): Promise<number>;

  createShareLink(args: {
    workspaceId: string;
    documentId: string;
    tokenHash: string;
    expiresAt: string;
    userId: string;
  }): Promise<void>;

  listShareLinks(workspaceId: string, documentId: string): Promise<ShareLinkInfo[]>;
  revokeShareLink(workspaceId: string, linkId: string): Promise<void>;

  recordAudit(workspaceId: string, userId: string, entry: AuditEntry): Promise<void>;
}

/**
 * Membership persistence. The service decides who may do what; the Supabase
 * adapter additionally re-checks every rule inside SECURITY DEFINER functions.
 */
export interface TeamRepository {
  listMembers(workspaceId: string): Promise<Member[]>;
  listInvites(workspaceId: string): Promise<Invite[]>;
  createInvite(args: { workspaceId: string; userId: string; email: string; role: Role }): Promise<Invite>;
  revokeInvite(workspaceId: string, inviteId: string): Promise<Invite | null>;
  setMemberRole(workspaceId: string, userId: string, role: Role): Promise<void>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
}

export interface ObjectStorage {
  createUploadTarget(
    key: string,
    opts: { mimeType: string; sizeBytes: number },
  ): Promise<UploadTarget>;
  stat(key: string): Promise<{ sizeBytes: number; mimeType: string | null } | null>;
  readHead(key: string, bytes: number): Promise<Uint8Array | null>;
  createDownloadUrl(
    key: string,
    opts: { fileName: string; disposition: "inline" | "attachment"; ttlSeconds: number },
  ): Promise<FileLink>;
  remove(keys: string[]): Promise<void>;
}
