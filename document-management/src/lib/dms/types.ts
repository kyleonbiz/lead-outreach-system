export const ROLES = ["viewer", "editor", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

export const CATEGORIES = [
  "invoice",
  "receipt",
  "tax",
  "contract",
  "hr",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  invoice: "Invoice",
  receipt: "Receipt",
  tax: "Tax Document",
  contract: "Contract",
  hr: "HR Document",
  other: "Other",
};

export type FolderColor =
  | "violet"
  | "blue"
  | "emerald"
  | "amber"
  | "rose"
  | "sky"
  | "orange"
  | "slate";

export interface Workspace {
  id: string;
  name: string;
  storageQuotaBytes: number;
}

export interface Folder {
  id: string;
  workspaceId: string;
  name: string;
  color: FolderColor;
  /** System folders are seeded per workspace and cannot be renamed or deleted. */
  isSystem: boolean;
  /** Category applied to uploads dropped into this folder. */
  defaultCategory: Category | null;
  createdAt: string;
}

export type FolderWithCount = Folder & { documentCount: number };

export type DocumentStatus = "pending" | "ready";

/** Whether a document's text is searchable. Only `indexed` documents match on content. */
export type ContentStatus = "pending" | "indexed" | "unsupported" | "failed";

export interface DocumentRecord {
  id: string;
  workspaceId: string;
  folderId: string | null;
  originalName: string;
  displayName: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  category: Category;
  tags: string[];
  uploadedBy: string;
  uploadedByName: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  starred: boolean;
  status: DocumentStatus;
  deletedAt: string | null;
  currentVersion: number;
  contentStatus: ContentStatus;
  /** Why content is not (fully) searchable: an extraction reason code, or "truncated". */
  contentReason: string | null;
  contentIndexedAt: string | null;
  /** Search results only: a short plain-text excerpt; matches are wrapped in U+E000 / U+E001. */
  snippet?: string | null;
  /** Search results only: true when the match came from the document's text. */
  contentMatch?: boolean;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  versionNumber: number;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
}

export interface DocumentDetail extends DocumentRecord {
  versions: DocumentVersion[];
}

export interface StorageUsage {
  usedBytes: number;
  quotaBytes: number;
  documentCount: number;
}

export type DocumentView = "all" | "recent" | "starred" | "trash";
export type DocumentSort =
  | "newest"
  | "oldest"
  | "name-asc"
  | "name-desc"
  | "size-desc"
  | "size-asc"
  /** Best match first. Only meaningful with a search term. */
  | "relevance";

export interface DocumentQuery {
  view: DocumentView;
  /** `null` means "All Files". */
  folderId: string | null;
  search: string;
  category: Category | null;
  /** File-type group id from `FILE_TYPE_GROUPS`. */
  fileType: string | null;
  tag: string | null;
  sort: DocumentSort;
  page: number;
  pageSize: number;
}

export interface DocumentPage {
  items: DocumentRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Bootstrap {
  workspace: Workspace;
  role: Role;
  user: { id: string; name: string; email: string };
  folders: FolderWithCount[];
  tags: string[];
  usage: StorageUsage;
  trashCount: number;
  limits: UploadLimits;
}

export interface UploadLimits {
  maxFileSizeBytes: number;
  allowedTypes: { extension: string; mimeTypes: string[]; label: string }[];
  maxFilesPerBatch: number;
}

export interface UploadTarget {
  /** `supabase-signed`: multipart PUT to a signed upload URL. `put`: raw PUT. `memory`: handled in-process (demo). */
  kind: "supabase-signed" | "put" | "memory";
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

export interface InitiateUploadResult {
  documentId: string;
  versionNumber: number;
  target: UploadTarget;
}

export interface FileLink {
  url: string;
  expiresAt: string;
}

export interface Member {
  userId: string;
  displayName: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  invitedAt: string;
  expiresAt: string;
}

export interface Team {
  members: Member[];
  invites: Invite[];
}

export interface ShareLinkInfo {
  id: string;
  createdAt: string;
  expiresAt: string;
  createdBy: string;
  createdByName: string;
}
