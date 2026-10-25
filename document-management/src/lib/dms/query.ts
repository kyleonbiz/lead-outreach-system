import type { DocumentQuery, DocumentRecord } from "./types";
import { CATEGORY_LABELS } from "./types";
import { fileTypeGroupOf, getExtension } from "./validation";

const RECENT_DAYS = 30;

/** Highlight delimiters used in snippets; stripped from stored text so they cannot be spoofed. */
export const HIGHLIGHT_START = "\uE000";
export const HIGHLIGHT_END = "\uE001";

/** Filename and metadata match: every whitespace-separated word must appear somewhere. */
export function matchesSearch(doc: DocumentRecord, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  const haystacks = [
    doc.displayName,
    doc.originalName,
    CATEGORY_LABELS[doc.category],
    getExtension(doc.originalName),
    doc.uploadedByName,
    ...doc.tags,
  ];
  return t.split(/\s+/).every((word) => haystacks.some((h) => h.toLowerCase().includes(word)));
}

/* ------------------------------ content search ------------------------------ */
/*
 * Reference implementation of the content query the SQL function runs with
 * websearch_to_tsquery('simple', …): words are ANDed, "quoted phrases" must be
 * adjacent, `or` separates alternatives, a leading `-` excludes. Tokens are
 * runs of letters and digits, lower-cased. PostgreSQL's parser is richer (it
 * keeps e-mail addresses and decimals as single tokens, for example), so the two
 * agree on ordinary words and phrases but not on every edge case.
 */
interface SearchTerm {
  words: string[];
  negated: boolean;
}

const tokenize = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Alternatives (split on `or`); each is a list of terms that must all hold. */
export function parseContentQuery(input: string): SearchTerm[][] {
  const groups: SearchTerm[][] = [[]];
  const re = /(-?)"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input.slice(0, 200)))) {
    if (m[3] !== undefined) {
      if (m[3].toLowerCase() === "or") {
        if (groups[groups.length - 1].length) groups.push([]);
        continue;
      }
      const negated = m[3].startsWith("-");
      const words = tokenize(negated ? m[3].slice(1) : m[3]);
      if (words.length) groups[groups.length - 1].push({ words, negated });
    } else {
      const words = tokenize(m[2]);
      if (words.length) groups[groups.length - 1].push({ words, negated: m[1] === "-" });
    }
  }
  return groups.filter((g) => g.length);
}

function occurrences(tokens: string[], words: string[]): number[] {
  const hits: number[] = [];
  for (let i = 0; i + words.length <= tokens.length; i++) {
    if (words.every((w, j) => tokens[i + j] === w)) hits.push(i);
  }
  return hits;
}

function contentScore(text: string, groups: SearchTerm[][]): number {
  const tokens = tokenize(text);
  let best = 0;
  for (const g of groups) {
    let score = 0;
    let ok = true;
    for (const term of g) {
      const n = occurrences(tokens, term.words).length;
      if (term.negated ? n > 0 : n === 0) {
        ok = false;
        break;
      }
      if (!term.negated) score += n;
    }
    if (ok) best = Math.max(best, score || 1);
  }
  return best;
}

/** A short plain-text excerpt around the first match, with matches wrapped in the highlight delimiters. */
export function makeSnippet(text: string, groups: SearchTerm[][]): string | null {
  const wanted = new Set(groups.flatMap((g) => g.filter((t) => !t.negated).flatMap((t) => t.words)));
  if (!wanted.size) return null;
  const re = /[\p{L}\p{N}]+/gu;
  let first = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (wanted.has(m[0].toLowerCase())) {
      first = m.index;
      break;
    }
  }
  if (first < 0) return null;
  const start = Math.max(0, first - 60);
  const end = Math.min(text.length, first + 140);
  const excerpt = text.slice(start, end).replace(/\s+/g, " ");
  const marked = excerpt.replace(/[\p{L}\p{N}]+/gu, (w) =>
    wanted.has(w.toLowerCase()) ? HIGHLIGHT_START + w + HIGHLIGHT_END : w,
  );
  return (start > 0 ? "… " : "") + marked.trim() + (end < text.length ? " …" : "");
}

/** Reference implementation of document filtering/sorting; the SQL function mirrors it. */
export function applyDocumentQuery(
  docs: DocumentRecord[],
  q: DocumentQuery,
  now: Date = new Date(),
  /** Extracted text by document id (current version). Only `indexed` documents are consulted. */
  texts: ReadonlyMap<string, string> = new Map(),
): { items: DocumentRecord[]; total: number } {
  const recentCutoff = now.getTime() - RECENT_DAYS * 86_400_000;

  let list = docs.filter((d) => d.status === "ready");
  list = q.view === "trash" ? list.filter((d) => d.deletedAt) : list.filter((d) => !d.deletedAt);
  if (q.view === "starred") list = list.filter((d) => d.starred);
  if (q.view === "recent") list = list.filter((d) => Date.parse(d.createdAt) >= recentCutoff);
  if (q.folderId) list = list.filter((d) => d.folderId === q.folderId);
  if (q.category) list = list.filter((d) => d.category === q.category);
  if (q.fileType) {
    list = list.filter((d) => fileTypeGroupOf(d.mimeType, d.originalName) === q.fileType);
  }
  if (q.tag) {
    const tag = q.tag.toLowerCase();
    list = list.filter((d) => d.tags.some((t) => t.toLowerCase() === tag));
  }
  const groups = q.search.trim() ? parseContentQuery(q.search) : [];
  const info = new Map<string, { meta: boolean; score: number }>();
  if (q.search.trim()) {
    list = list.filter((d) => {
      const meta = matchesSearch(d, q.search);
      const text = d.contentStatus === "indexed" ? texts.get(d.id) : undefined;
      const score = text && groups.length ? contentScore(text, groups) : 0;
      info.set(d.id, { meta, score });
      return meta || score > 0;
    });
  }

  const sorters: Record<DocumentQuery["sort"], (a: DocumentRecord, b: DocumentRecord) => number> = {
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
    "name-asc": (a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
    "name-desc": (a, b) => b.displayName.localeCompare(a.displayName, undefined, { sensitivity: "base" }),
    "size-desc": (a, b) => b.sizeBytes - a.sizeBytes,
    "size-asc": (a, b) => a.sizeBytes - b.sizeBytes,
    // Filename/metadata matches first, then by how often the content matched.
    relevance: (a, b) => {
      const ia = info.get(a.id);
      const ib = info.get(b.id);
      return (
        Number(ib?.meta ?? 0) - Number(ia?.meta ?? 0) ||
        (ib?.score ?? 0) - (ia?.score ?? 0) ||
        b.createdAt.localeCompare(a.createdAt)
      );
    },
  };
  list = [...list].sort((a, b) => sorters[q.sort](a, b) || a.id.localeCompare(b.id));

  const total = list.length;
  const start = (q.page - 1) * q.pageSize;
  const items = list.slice(start, start + q.pageSize).map((d) => {
    const i = info.get(d.id);
    if (!i) return d;
    const hit = i.score > 0;
    return { ...d, contentMatch: hit, snippet: hit ? makeSnippet(texts.get(d.id) ?? "", groups) : null };
  });
  return { items, total };
}
