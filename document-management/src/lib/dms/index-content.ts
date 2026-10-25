import { canExtract, extractText } from "./extract";
import { DEFAULT_EXTRACT_LIMITS, type ExtractLimits } from "./extract/limits";
import type { ObjectStorage } from "./ports";
import type { ContentStatus } from "./types";

export interface ContentOutcome {
  status: Exclude<ContentStatus, "pending">;
  reason: string | null;
  text: string | null;
}

/**
 * Reads a stored file and extracts its text. Never throws: every problem becomes
 * an outcome that can be stored, so indexing can never break an upload. Files
 * whose type has no extractor are not even downloaded.
 */
export async function computeContent(
  storage: ObjectStorage,
  file: { storageKey: string; fileName: string; mimeType?: string },
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
): Promise<ContentOutcome> {
  if (!canExtract(file.fileName)) return { status: "unsupported", reason: "unsupported_type", text: null };
  try {
    const read = await storage.read(file.storageKey, limits.maxInputBytes);
    if (!read) return { status: "failed", reason: "read_error", text: null };
    if ("tooLarge" in read) return { status: "unsupported", reason: "too_large", text: null };
    const r = await extractText({ bytes: read.bytes, fileName: file.fileName, mimeType: file.mimeType }, limits);
    return { status: r.status, reason: r.reason, text: r.status === "indexed" ? r.text : null };
  } catch {
    return { status: "failed", reason: "read_error", text: null };
  }
}
