import { z } from "zod";
import {
  CATEGORIES,
  type Category,
  type DocumentQuery,
  type UploadLimits,
} from "./types";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SHARE_LINK_MAX_MINUTES,
} from "./config";

/* ------------------------------------------------------------------ */
/* Filenames                                                           */
/* ------------------------------------------------------------------ */

const MAX_NAME_LENGTH = 150;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const PATH_CHARS = /[\\/:*?"<>|]/g;
const BIDI_CHARS = /[‎‏‪-‮⁦-⁩]/g;

/**
 * Turns an arbitrary client-supplied filename into a safe display name.
 * Never used to build storage paths: keys are generated server-side.
 */
export function sanitizeFilename(input: string): string {
  let name = input
    .normalize("NFC")
    .replace(CONTROL_CHARS, "")
    .replace(BIDI_CHARS, "")
    .replace(PATH_CHARS, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");

  if (name.length > MAX_NAME_LENGTH) {
    const ext = getExtension(name);
    const keep = MAX_NAME_LENGTH - (ext ? ext.length + 1 : 0);
    const stem = ext ? name.slice(0, name.length - ext.length - 1) : name;
    name = stem.slice(0, keep) + (ext ? `.${ext}` : "");
  }
  return name;
}

export function getExtension(filename: string): string {
  const i = filename.lastIndexOf(".");
  if (i <= 0 || i === filename.length - 1) return "";
  return filename.slice(i + 1).toLowerCase();
}

/** A display name for rename: sanitised, non-empty, keeps the original extension if the user dropped it. */
export function normalizeRename(next: string, originalName: string): string {
  const clean = sanitizeFilename(next);
  if (!clean) return "";
  const origExt = getExtension(originalName);
  if (origExt && getExtension(clean) !== origExt) return `${clean}.${origExt}`;
  return clean;
}

export function buildStorageKey(args: {
  workspaceId: string;
  documentId: string;
  versionNumber: number;
  extension: string;
  nonce: string;
}): string {
  const ext = /^[a-z0-9]{1,10}$/.test(args.extension) ? args.extension : "bin";
  for (const part of [args.workspaceId, args.documentId, args.nonce]) {
    if (!/^[A-Za-z0-9-]+$/.test(part)) throw new Error("Unsafe storage key part");
  }
  return `${args.workspaceId}/${args.documentId}/v${args.versionNumber}-${args.nonce}.${ext}`;
}

/** Returns the workspace id a storage key claims to belong to, or null if malformed. */
export function workspaceOfKey(key: string): string | null {
  const m = /^([0-9a-f-]{36})\/[0-9a-f-]{36}\/v\d+-[A-Za-z0-9-]+\.[a-z0-9]{1,10}$/.exec(key);
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------ */
/* Upload validation                                                   */
/* ------------------------------------------------------------------ */

export interface FileCandidate {
  name: string;
  size: number;
  type: string;
}

export type UploadValidation =
  | { ok: true; displayName: string; extension: string; mimeType: string }
  | { ok: false; reason: string };

export function validateUploadCandidate(
  file: FileCandidate,
  limits: UploadLimits,
): UploadValidation {
  const displayName = sanitizeFilename(file.name);
  if (!displayName) return { ok: false, reason: "The file name is not valid." };

  const extension = getExtension(displayName);
  if (!extension) return { ok: false, reason: "The file has no extension." };

  const allowedForExt = limits.allowedTypes.filter((t) => t.extension === extension);
  if (allowedForExt.length === 0) {
    return { ok: false, reason: `.${extension} files are not allowed.` };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, reason: "The file is empty." };
  }
  if (file.size > limits.maxFileSizeBytes) {
    return {
      ok: false,
      reason: `The file is larger than the ${formatBytes(limits.maxFileSizeBytes)} limit.`,
    };
  }

  const mime = file.type.toLowerCase().split(";")[0].trim();
  const accepted = allowedForExt.flatMap((t) => t.mimeTypes);
  // Browsers sometimes report an empty type; fall back to the extension's canonical type.
  const mimeType = mime || accepted[0];
  if (!accepted.includes(mimeType)) {
    return {
      ok: false,
      reason: `The file type "${mime}" does not match its .${extension} extension.`,
    };
  }
  return { ok: true, displayName, extension, mimeType };
}

const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  pdf: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  png: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  jpeg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  docx: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
  xlsx: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
  pptx: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
};

function startsWith(b: Uint8Array, sig: number[]) {
  return b.length >= sig.length && sig.every((v, i) => b[i] === v);
}

/** Checks the leading bytes against the claimed extension. Unknown extensions pass (text formats have no magic). */
export function magicBytesMatch(extension: string, head: Uint8Array): boolean {
  const check = MAGIC[extension];
  return check ? check(head) : true;
}

/* ------------------------------------------------------------------ */
/* File-type groups (filter chips) & formatting                        */
/* ------------------------------------------------------------------ */

export interface FileTypeGroup {
  id: string;
  label: string;
  match: (mimeType: string, extension: string) => boolean;
}

export const FILE_TYPE_GROUPS: FileTypeGroup[] = [
  { id: "pdf", label: "PDF", match: (_m, e) => e === "pdf" },
  { id: "word", label: "Word", match: (_m, e) => e === "docx" || e === "doc" },
  { id: "excel", label: "Excel", match: (_m, e) => e === "xlsx" || e === "xls" },
  { id: "csv", label: "CSV", match: (_m, e) => e === "csv" },
  {
    id: "image",
    label: "Images",
    match: (m, e) => m.startsWith("image/") || ["jpg", "jpeg", "png"].includes(e),
  },
];

export function fileTypeGroupOf(mimeType: string, filename: string): string {
  const ext = getExtension(filename);
  return FILE_TYPE_GROUPS.find((g) => g.match(mimeType, ext))?.id ?? "other";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/* ------------------------------------------------------------------ */
/* Request schemas                                                     */
/* ------------------------------------------------------------------ */

export const uuid = z.string().uuid();

export const tagName = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[\p{L}\p{N} _.&-]+$/u, "Tags may contain letters, numbers, spaces and - _ . &");

export const folderNameSchema = z
  .string()
  .trim()
  .min(1, "Folder name is required")
  .max(60, "Folder name is too long")
  .regex(/^[^\\/:*?"<>|\u0000-\u001f]+$/, "Folder name contains invalid characters");

export const folderColorSchema = z.enum([
  "violet",
  "blue",
  "emerald",
  "amber",
  "rose",
  "sky",
  "orange",
  "slate",
]);

export const createFolderSchema = z.object({
  name: folderNameSchema,
  color: folderColorSchema.optional(),
});

export const renameFolderSchema = z.object({ name: folderNameSchema });

export const categorySchema = z.enum(CATEGORIES);

export const initiateUploadSchema = z.object({
  fileName: z.string().min(1).max(500),
  size: z.number().int().positive(),
  mimeType: z.string().max(200),
  folderId: uuid.nullable(),
  category: categorySchema.optional(),
  /** When set, uploads a new version of an existing document. */
  documentId: uuid.optional(),
});
export type InitiateUploadInput = z.infer<typeof initiateUploadSchema>;

export const updateDocumentSchema = z
  .object({
    displayName: z.string().min(1).max(500).optional(),
    folderId: uuid.nullable().optional(),
    starred: z.boolean().optional(),
    tags: z.array(tagName).max(20).optional(),
    category: categorySchema.optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;

export const shareLinkSchema = z.object({
  ttlMinutes: z.number().int().min(5).max(SHARE_LINK_MAX_MINUTES),
});

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(80, "Name is too long"),
});

export const roleSchema = z.enum(["viewer", "editor", "admin", "owner"]);

export const inviteMemberSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Enter a valid email address"),
  role: roleSchema,
});

export const changeRoleSchema = z.object({ role: roleSchema });

export const signInSchema = z.object({
  email: z.string().trim().email("Enter a valid email"),
  password: z.string().min(8, "Use at least 8 characters").max(200),
});

const sortValues = ["newest", "oldest", "name-asc", "name-desc", "size-desc", "size-asc", "relevance"] as const;

export const documentQuerySchema = z.object({
  view: z.enum(["all", "recent", "starred", "trash"]).default("all"),
  folderId: uuid.nullable().default(null),
  search: z.string().trim().max(100).default(""),
  category: categorySchema.nullable().default(null),
  fileType: z.string().max(20).nullable().default(null),
  tag: tagName.nullable().default(null),
  sort: z.enum(sortValues).default("newest"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export function defaultQuery(): DocumentQuery {
  return documentQuerySchema.parse({});
}

export function categoryForFolderName(name: string): Category {
  const n = name.toLowerCase();
  if (n.includes("invoice")) return "invoice";
  if (n.includes("receipt")) return "receipt";
  if (n.includes("tax")) return "tax";
  if (n.includes("contract")) return "contract";
  if (n.includes("hr")) return "hr";
  return "other";
}
