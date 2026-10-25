import type { UploadLimits } from "./types";

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

export interface AllowedType {
  extension: string;
  mimeTypes: string[];
  label: string;
}

/**
 * The default allow-list. Extensions are matched case-insensitively and every
 * upload must match BOTH an extension and one of its MIME types.
 * Extend or restrict at deploy time with `DMS_EXTRA_FILE_TYPES` / `DMS_ALLOWED_EXTENSIONS`.
 */
export const DEFAULT_ALLOWED_TYPES: AllowedType[] = [
  { extension: "pdf", mimeTypes: ["application/pdf"], label: "PDF" },
  {
    extension: "docx",
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    label: "Word",
  },
  {
    extension: "xlsx",
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    label: "Excel",
  },
  {
    extension: "csv",
    mimeTypes: ["text/csv", "application/csv", "application/vnd.ms-excel"],
    label: "CSV",
  },
  { extension: "jpg", mimeTypes: ["image/jpeg"], label: "JPG" },
  { extension: "jpeg", mimeTypes: ["image/jpeg"], label: "JPEG" },
  { extension: "png", mimeTypes: ["image/png"], label: "PNG" },
  { extension: "txt", mimeTypes: ["text/plain"], label: "Text" },
  {
    extension: "pptx",
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    label: "PowerPoint",
  },
];

/**
 * Types that execute or render script when a browser opens them. They can never
 * be enabled through DMS_EXTRA_FILE_TYPES, because previews and the dev download
 * route can serve a file inline from a trusted origin.
 */
export const BLOCKED_EXTENSIONS = new Set([
  "html", "htm", "xhtml", "shtml", "svg", "svgz", "xml", "xsl", "xslt", "js", "mjs", "cjs",
  "jsx", "ts", "php", "asp", "aspx", "jsp", "swf", "hta", "exe", "msi", "bat", "cmd", "com",
  "scr", "ps1", "sh", "jar", "dll", "apk", "vbs", "wsf",
]);
export const BLOCKED_MIME_PATTERNS = [
  /^text\/html/, /^application\/xhtml/, /^image\/svg/, /xml$/, /javascript/, /ecmascript/,
  /^application\/x-(msdownload|sh|csh|httpd-php)/, /^application\/java-archive/,
];

export function isBlockedType(extension: string, mimeTypes: string[]): boolean {
  return (
    BLOCKED_EXTENSIONS.has(extension) ||
    mimeTypes.some((m) => BLOCKED_MIME_PATTERNS.some((re) => re.test(m)))
  );
}

export const DEFAULT_MAX_FILE_SIZE = 50 * MB;
export const DEFAULT_QUOTA = 5 * GB;
export const DEFAULT_MAX_FILES_PER_BATCH = 10;

export const SIGNED_URL_TTL_SECONDS = 60;
export const SHARE_LINK_MAX_MINUTES = 60 * 24 * 7;
export const SHARE_LINK_DEFAULT_MINUTES = 60;
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 100;

/** Reads env-driven overrides. Safe to call on the server only. */
export function loadUploadLimits(
  env: Record<string, string | undefined> = process.env,
): UploadLimits {
  const max = Number(env.DMS_MAX_FILE_SIZE_MB);
  const batch = Number(env.DMS_MAX_FILES_PER_BATCH);
  let allowed = DEFAULT_ALLOWED_TYPES;

  const only = env.DMS_ALLOWED_EXTENSIONS?.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (only?.length) allowed = allowed.filter((t) => only.includes(t.extension));

  // DMS_EXTRA_FILE_TYPES="rtf=application/rtf;odt=application/vnd.oasis.opendocument.text"
  const extra = env.DMS_EXTRA_FILE_TYPES?.split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair): AllowedType | null => {
      const [ext, mimes] = pair.split("=");
      if (!ext || !mimes) return null;
      const extension = ext.trim().toLowerCase().replace(/^\./, "");
      if (!/^[a-z0-9]{1,10}$/.test(extension)) return null;
      return {
        extension,
        mimeTypes: mimes.split("|").map((m) => m.trim().toLowerCase()),
        label: extension.toUpperCase(),
      };
    })
    .filter((t): t is AllowedType => t !== null)
    .filter((t) => !isBlockedType(t.extension, t.mimeTypes));
  if (extra?.length) allowed = [...allowed, ...extra];

  return {
    maxFileSizeBytes: Number.isFinite(max) && max > 0 ? max * MB : DEFAULT_MAX_FILE_SIZE,
    maxFilesPerBatch:
      Number.isFinite(batch) && batch > 0 ? batch : DEFAULT_MAX_FILES_PER_BATCH,
    allowedTypes: allowed,
  };
}

export function defaultUploadLimits(): UploadLimits {
  return {
    maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE,
    maxFilesPerBatch: DEFAULT_MAX_FILES_PER_BATCH,
    allowedTypes: DEFAULT_ALLOWED_TYPES,
  };
}
