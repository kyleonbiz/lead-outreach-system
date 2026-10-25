/**
 * Hard limits for content extraction. Files are untrusted: every parser below
 * checks these as it reads, not only up front, because headers can lie.
 */
export interface ExtractLimits {
  /** Largest stored file we will even read into memory. */
  maxInputBytes: number;
  /** Characters kept per document (the rest is dropped and `truncated` is set). */
  maxTextChars: number;
  /** Archive entries we will look at. */
  maxZipEntries: number;
  /** Decompressed bytes for any single archive entry. */
  maxEntryBytes: number;
  /** Decompressed bytes across all entries of one file. */
  maxTotalBytes: number;
  /** Largest allowed expansion ratio for an entry once it exceeds `ratioFloorBytes`. */
  maxRatio: number;
  ratioFloorBytes: number;
  /** PDF pages read before stopping. */
  maxPdfPages: number;
  /** Wall-clock budget per file, checked between units of work. */
  timeoutMs: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxInputBytes: 25 * 1024 * 1024,
  maxTextChars: 1_000_000,
  maxZipEntries: 3000,
  maxEntryBytes: 40 * 1024 * 1024,
  maxTotalBytes: 80 * 1024 * 1024,
  maxRatio: 150,
  ratioFloorBytes: 1024 * 1024,
  maxPdfPages: 300,
  timeoutMs: 20_000,
};
