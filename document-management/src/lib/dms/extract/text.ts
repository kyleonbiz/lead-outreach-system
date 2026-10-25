/** Start/stop markers for search highlights live in the Unicode private-use area. Never allow them in content. */
export const MARK_START = "";
export const MARK_END = "";

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** Decodes bytes as UTF-8 or (with a BOM) UTF-16, never throwing on bad sequences. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Makes extracted text safe to store and search: no control characters, no
 * highlight markers, no lone surrogates, collapsed whitespace.
 */
export function normalizeText(input: string, maxChars: number): { text: string; truncated: boolean } {
  let s = input.replace(UNSAFE, " ");
  s = s.replace(/[ \t\f\v ]+/g, " ").replace(/ ?\r?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = s.length > maxChars;
  if (truncated) s = s.slice(0, maxChars);
  // Lone surrogates are invalid UTF-8 and would make Postgres reject the row.
  const wf = (s as string & { toWellFormed?: () => string }).toWellFormed;
  s = wf ? wf.call(s) : s.replace(/[\ud800-\udfff]/g, (c, i, str) => isPair(str, i) ? c : "�");
  return { text: s, truncated };
}

function isPair(str: string, i: number): boolean {
  const c = str.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff) {
    const n = str.charCodeAt(i + 1);
    return n >= 0xdc00 && n <= 0xdfff;
  }
  const p = str.charCodeAt(i - 1);
  return c >= 0xdc00 && c <= 0xdfff && p >= 0xd800 && p <= 0xdbff;
}
