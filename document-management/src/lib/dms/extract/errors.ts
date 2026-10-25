/** Why a file could not be indexed. `unsupported` is expected; `failed` may be retried. */
export type ExtractReason =
  | "unsupported_type"
  | "no_text_found"
  | "too_large"
  | "encrypted"
  | "unsafe_archive"
  | "parse_error"
  | "timeout"
  | "read_error";

export class ExtractError extends Error {
  readonly kind: "unsupported" | "failed";
  readonly reason: ExtractReason;
  constructor(kind: "unsupported" | "failed", reason: ExtractReason) {
    super(reason);
    this.name = "ExtractError";
    this.kind = kind;
    this.reason = reason;
  }
}

export const REASON_LABELS: Record<string, string> = {
  unsupported_type: "This file type has no extractable text.",
  no_text_found: "No text was found (scanned or image-only files are not read).",
  too_large: "The file is too large to index.",
  encrypted: "The file is password-protected.",
  unsafe_archive: "The file's structure was rejected as unsafe.",
  parse_error: "The file could not be read.",
  timeout: "Reading the file took too long.",
  read_error: "The stored file could not be read.",
  sample_no_content: "Sample record: the demo has no file content to read.",
  truncated: "Only the first part of the text is searchable.",
};
