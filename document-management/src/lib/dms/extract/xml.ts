/**
 * A deliberately tiny XML text scanner. We never build a DOM and never resolve
 * DOCTYPEs or external entities, so XXE and entity-expansion attacks have
 * nothing to act on. Only the five predefined entities and numeric character
 * references are decoded; anything else is left as-is.
 */

const ENTITY = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g;

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(ENTITY, (_m, e: string) => {
    switch (e) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
    }
    const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
  });
}

export interface Tag {
  /** Local-name-with-prefix as written, e.g. `w:t`. */
  name: string;
  closing: boolean;
  selfClosing: boolean;
  /** Raw attribute text between the name and `>`. */
  attrs: string;
  /** Index just past the `>`. */
  end: number;
}

/** Finds the next element tag at or after `from`, skipping comments, PIs, CDATA and DOCTYPE. */
export function nextTag(xml: string, from: number): Tag | null {
  let i = from;
  for (;;) {
    i = xml.indexOf("<", i);
    if (i < 0) return null;
    const c = xml.charCodeAt(i + 1);
    if (c === 33 /* ! */ || c === 63 /* ? */) {
      // <!-- --> , <![CDATA[ ]]> , <!DOCTYPE ...> , <?pi?>
      const close = xml.startsWith("<!--", i) ? "-->" : xml.startsWith("<![CDATA[", i) ? "]]>" : c === 63 ? "?>" : ">";
      const j = xml.indexOf(close, i + 2);
      if (j < 0) return null;
      i = j + close.length;
      continue;
    }
    const gt = xml.indexOf(">", i + 1);
    if (gt < 0) return null;
    const inner = xml.slice(i + 1, gt);
    const closing = inner.startsWith("/");
    const selfClosing = inner.endsWith("/");
    const body = inner.slice(closing ? 1 : 0, selfClosing ? -1 : undefined);
    const sp = body.search(/[\s]/);
    return {
      name: sp < 0 ? body : body.slice(0, sp),
      closing,
      selfClosing,
      attrs: sp < 0 ? "" : body.slice(sp + 1),
      end: gt + 1,
    };
  }
}

export function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? "") : null;
}

/**
 * Collects the text of `textTags` (e.g. `w:t`), emitting a newline at each
 * `breakTags` element end and a space for `spaceTags`. Text inside `skipTags`
 * (e.g. phonetic runs) is ignored. `deadline` is checked periodically.
 */
export function collectText(
  xml: string,
  opts: { textTags: string[]; breakTags?: string[]; spaceTags?: string[]; skipTags?: string[]; maxChars: number; check: () => void },
): string {
  const text = new Set(opts.textTags);
  const brk = new Set(opts.breakTags ?? []);
  const space = new Set(opts.spaceTags ?? []);
  const skip = new Set(opts.skipTags ?? []);
  let out = "";
  let pos = 0;
  let skipDepth = 0;
  let n = 0;
  for (;;) {
    const tag = nextTag(xml, pos);
    if (!tag) break;
    pos = tag.end;
    if ((++n & 0x3fff) === 0) opts.check();
    if (skip.has(tag.name)) {
      if (!tag.selfClosing) skipDepth += tag.closing ? -1 : 1;
      continue;
    }
    if (skipDepth > 0) continue;
    if (tag.closing) {
      if (brk.has(tag.name)) out += "\n";
      continue;
    }
    if (text.has(tag.name) && !tag.selfClosing) {
      const close = xml.indexOf("<", pos);
      if (close < 0) break;
      out += decodeEntities(xml.slice(pos, close));
      pos = close;
    } else if (space.has(tag.name)) out += " ";
    else if (tag.selfClosing && brk.has(tag.name)) out += "\n";
    if (out.length > opts.maxChars * 2) break; // normalised and trimmed later
  }
  return out;
}
