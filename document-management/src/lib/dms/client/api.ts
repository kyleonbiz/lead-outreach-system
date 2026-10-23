import type {
  Bootstrap,
  Category,
  DocumentDetail,
  DocumentPage,
  DocumentQuery,
  DocumentRecord,
  FileLink,
  Folder,
} from "../types";

export type ApiMode = "demo" | "dev" | "live";

export interface UploadArgs {
  file: File;
  folderId: string | null;
  category?: Category;
  /** Uploads a new version of this document instead of creating one. */
  documentId?: string;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

export interface DocumentChanges {
  displayName?: string;
  folderId?: string | null;
  starred?: boolean;
  tags?: string[];
  category?: Category;
  expiresAt?: string | null;
}

/** Everything the UI can ask of the backend. Implementations: HTTP (real) and in-browser (demo). */
export interface DmsApi {
  readonly mode: ApiMode;
  readonly capabilities: { share: boolean };
  bootstrap(): Promise<Bootstrap>;
  listDocuments(q: DocumentQuery): Promise<DocumentPage>;
  getDocument(id: string): Promise<DocumentDetail>;
  uploadFile(args: UploadArgs): Promise<DocumentRecord>;
  updateDocument(id: string, changes: DocumentChanges): Promise<DocumentRecord>;
  deleteDocument(id: string): Promise<void>;
  restoreDocument(id: string): Promise<DocumentRecord>;
  purgeDocument(id: string): Promise<void>;
  getFileLink(
    id: string,
    opts?: { versionNumber?: number; disposition?: "inline" | "attachment" },
  ): Promise<FileLink>;
  createShareLink(id: string, ttlMinutes: number): Promise<{ url: string; expiresAt: string }>;
  createFolder(name: string): Promise<Folder>;
  renameFolder(id: string, name: string): Promise<Folder>;
  deleteFolder(id: string): Promise<void>;
}
