import { ExtractError } from "./errors";
import type { ExtractLimits } from "./limits";

/**
 * Text layer only: there is no OCR, so scanned PDFs yield no text and are
 * reported as such. PDF.js is loaded lazily and run with script evaluation,
 * XFA forms and font loading switched off.
 */
export async function extractPdf(
  bytes: Uint8Array,
  limits: ExtractLimits,
  check: () => void,
): Promise<{ text: string; truncatedPages: boolean }> {
  const { getDocumentProxy } = await import("unpdf");
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // PDF.js takes ownership of the buffer, so hand it a copy.
    pdf = await getDocumentProxy(new Uint8Array(bytes), {
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
      stopAtErrors: false,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === "PasswordException") throw new ExtractError("unsupported", "encrypted");
    throw new ExtractError("unsupported", "parse_error");
  }
  try {
    const pages = Math.min(pdf.numPages, limits.maxPdfPages);
    let out = "";
    for (let i = 1; i <= pages; i++) {
      check();
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if ("str" in item) out += item.str + (item.hasEOL ? "\n" : "");
      }
      out += "\n";
      page.cleanup();
      if (out.length > limits.maxTextChars * 2) break;
    }
    return { text: out, truncatedPages: pdf.numPages > pages };
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    throw new ExtractError("unsupported", "parse_error");
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}
