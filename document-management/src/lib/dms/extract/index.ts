import { ExtractError, type ExtractReason } from "./errors";
import { DEFAULT_EXTRACT_LIMITS, type ExtractLimits } from "./limits";
import { extractDocx, extractPptx, extractXlsx } from "./office";
import { extractPdf } from "./pdf";
import { decodeText, normalizeText } from "./text";

export type ContentStatus = "pending" | "indexed" | "unsupported" | "failed";

export interface ExtractResult {
  status: Exclude<ContentStatus, "pending">;
  /** Present for unsupported/failed, and `truncated` for indexed-but-partial text. */
  reason: ExtractReason | "truncated" | null;
  text: string;
}

export interface ExtractInput {
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string;
}

const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

/** File types we can read. Everything else is reported as unsupported, never guessed at. */
export const EXTRACTABLE_EXTENSIONS = ["pdf", "docx", "xlsx", "pptx", "csv", "txt"] as const;

export function canExtract(fileName: string): boolean {
  return (EXTRACTABLE_EXTENSIONS as readonly string[]).includes(extOf(fileName));
}

function deadline(ms: number) {
  const end = Date.now() + ms;
  return () => {
    if (Date.now() > end) throw new ExtractError("failed", "timeout");
  };
}

/**
 * Extracts searchable text. Never throws: any problem becomes a status the
 * caller can store. Indexing is best-effort and must never block an upload.
 */
export async function extractText(
  input: ExtractInput,
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
): Promise<ExtractResult> {
  const ext = extOf(input.fileName);
  if (!canExtract(input.fileName)) return { status: "unsupported", reason: "unsupported_type", text: "" };
  if (input.bytes.length > limits.maxInputBytes) return { status: "unsupported", reason: "too_large", text: "" };

  const check = deadline(limits.timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ExtractError("failed", "timeout")), limits.timeoutMs + 500);
  });

  const work = async (): Promise<{ raw: string; partial: boolean }> => {
    switch (ext) {
      case "csv":
      case "txt":
        return { raw: decodeText(input.bytes.subarray(0, limits.maxTextChars * 4)), partial: false };
      case "docx":
        return { raw: extractDocx(input.bytes, limits, check), partial: false };
      case "xlsx":
        return { raw: extractXlsx(input.bytes, limits, check), partial: false };
      case "pptx":
        return { raw: extractPptx(input.bytes, limits, check), partial: false };
      default: {
        const r = await extractPdf(input.bytes, limits, check);
        return { raw: r.text, partial: r.truncatedPages };
      }
    }
  };

  try {
    const { raw, partial } = await Promise.race([work(), timeout]);
    const { text, truncated } = normalizeText(raw, limits.maxTextChars);
    if (!/[\p{L}\p{N}]/u.test(text)) return { status: "unsupported", reason: "no_text_found", text: "" };
    return { status: "indexed", reason: truncated || partial ? "truncated" : null, text };
  } catch (e) {
    if (e instanceof ExtractError) return { status: e.kind, reason: e.reason, text: "" };
    return { status: "unsupported", reason: "parse_error", text: "" };
  } finally {
    clearTimeout(timer);
  }
}
