import { ExtractError } from "./errors";
import type { ExtractLimits } from "./limits";
import { attr, collectText, decodeEntities, nextTag } from "./xml";
import { listZip, readEntry, type ZipEntry } from "./zip";

const utf8 = new TextDecoder("utf-8", { fatal: false });

class Archive {
  private readonly entries: Map<string, ZipEntry>;
  private readonly budget: { remaining: number };
  constructor(
    private readonly data: Uint8Array,
    private readonly limits: ExtractLimits,
    private readonly check: () => void,
  ) {
    this.entries = listZip(data, limits);
    this.budget = { remaining: limits.maxTotalBytes };
  }
  has(name: string) {
    return this.entries.has(name);
  }
  names(pattern: RegExp) {
    return [...this.entries.keys()].filter((n) => pattern.test(n)).sort(naturalCompare);
  }
  text(name: string): string {
    this.check();
    const e = this.entries.get(name);
    if (!e) throw new ExtractError("unsupported", "parse_error");
    return utf8.decode(readEntry(this.data, e, this.limits, this.budget));
  }
}

function naturalCompare(a: string, b: string) {
  return a.localeCompare(b, "en", { numeric: true });
}

export function extractDocx(data: Uint8Array, limits: ExtractLimits, check: () => void): string {
  const zip = new Archive(data, limits, check);
  if (!zip.has("word/document.xml")) throw new ExtractError("unsupported", "parse_error");
  const parts = ["word/document.xml", ...zip.names(/^word\/(header\d*|footer\d*|footnotes|endnotes)\.xml$/)];
  let out = "";
  for (const part of parts) {
    out += collectText(zip.text(part), {
      textTags: ["w:t"],
      breakTags: ["w:p", "w:br", "w:cr"],
      spaceTags: ["w:tab", "w:noBreakHyphen"],
      maxChars: limits.maxTextChars,
      check,
    }) + "\n";
    if (out.length > limits.maxTextChars * 2) break;
  }
  return out;
}

export function extractPptx(data: Uint8Array, limits: ExtractLimits, check: () => void): string {
  const zip = new Archive(data, limits, check);
  const slides = zip.names(/^ppt\/slides\/slide\d+\.xml$/);
  if (slides.length === 0) throw new ExtractError("unsupported", "parse_error");
  let out = "";
  for (const part of [...slides, ...zip.names(/^ppt\/notesSlides\/notesSlide\d+\.xml$/)]) {
    out += collectText(zip.text(part), {
      textTags: ["a:t"],
      breakTags: ["a:p"],
      maxChars: limits.maxTextChars,
      check,
    }) + "\n";
    if (out.length > limits.maxTextChars * 2) break;
  }
  return out;
}

function readSharedStrings(xml: string, maxChars: number, check: () => void): string[] {
  const strings: string[] = [];
  let cur: string | null = null;
  let skip = 0;
  let total = 0;
  let pos = 0;
  let n = 0;
  for (;;) {
    const tag = nextTag(xml, pos);
    if (!tag) break;
    pos = tag.end;
    if ((++n & 0x3fff) === 0) check();
    if (tag.name === "rPh" || tag.name === "phoneticPr") {
      if (!tag.selfClosing) skip += tag.closing ? -1 : 1;
      continue;
    }
    if (skip > 0) continue;
    if (tag.name === "si") {
      if (tag.closing) {
        strings.push(cur ?? "");
        cur = null;
      } else if (tag.selfClosing) strings.push("");
      else cur = "";
    } else if (tag.name === "t" && !tag.closing && !tag.selfClosing && cur !== null) {
      const close = xml.indexOf("<", pos);
      if (close < 0) break;
      const s = decodeEntities(xml.slice(pos, close));
      cur += s;
      total += s.length;
      pos = close;
      if (total > maxChars * 4) break;
    }
  }
  return strings;
}

function extractSheet(xml: string, shared: string[], maxChars: number, check: () => void): string {
  let out = "";
  let cellType = "";
  let pos = 0;
  let n = 0;
  for (;;) {
    const tag = nextTag(xml, pos);
    if (!tag) break;
    pos = tag.end;
    if ((++n & 0x3fff) === 0) check();
    if (tag.closing) {
      if (tag.name === "row") out += "\n";
      continue;
    }
    if (tag.name === "c") {
      cellType = attr(tag.attrs, "t") ?? "";
    } else if ((tag.name === "v" || tag.name === "t") && !tag.selfClosing) {
      const close = xml.indexOf("<", pos);
      if (close < 0) break;
      const raw = xml.slice(pos, close);
      pos = close;
      if (tag.name === "v") {
        if (cellType === "s") out += shared[Number(raw)] ?? "";
        else if (cellType === "b" || cellType === "e") continue;
        else out += decodeEntities(raw);
      } else out += decodeEntities(raw); // inline string run
      out += " ";
    }
    if (out.length > maxChars * 2) break;
  }
  return out;
}

export function extractXlsx(data: Uint8Array, limits: ExtractLimits, check: () => void): string {
  const zip = new Archive(data, limits, check);
  const sheets = zip.names(/^xl\/worksheets\/[^/]+\.xml$/);
  if (!zip.has("xl/workbook.xml") || sheets.length === 0) throw new ExtractError("unsupported", "parse_error");

  let out = "";
  const names: string[] = [];
  let pos = 0;
  const wb = zip.text("xl/workbook.xml");
  for (;;) {
    const tag = nextTag(wb, pos);
    if (!tag) break;
    pos = tag.end;
    if (tag.name === "sheet" && !tag.closing) {
      const name = attr(tag.attrs, "name");
      if (name) names.push(name);
    }
  }
  out += names.join("\n") + "\n";

  const shared = zip.has("xl/sharedStrings.xml")
    ? readSharedStrings(zip.text("xl/sharedStrings.xml"), limits.maxTextChars, check)
    : [];
  for (const sheet of sheets) {
    out += extractSheet(zip.text(sheet), shared, limits.maxTextChars, check) + "\n";
    if (out.length > limits.maxTextChars * 2) break;
  }
  return out;
}
