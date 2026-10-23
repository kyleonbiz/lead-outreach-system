import type { DocumentQuery, DocumentRecord } from "./types";
import { CATEGORY_LABELS } from "./types";
import { fileTypeGroupOf, getExtension } from "./validation";

const RECENT_DAYS = 30;

export function matchesSearch(doc: DocumentRecord, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  // Filename first, then metadata and tags. Document *content* is not indexed yet.
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

/** Reference implementation of document filtering/sorting; the SQL function mirrors it. */
export function applyDocumentQuery(
  docs: DocumentRecord[],
  q: DocumentQuery,
  now: Date = new Date(),
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
  if (q.search) list = list.filter((d) => matchesSearch(d, q.search));

  const sorters: Record<DocumentQuery["sort"], (a: DocumentRecord, b: DocumentRecord) => number> = {
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
    "name-asc": (a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
    "name-desc": (a, b) => b.displayName.localeCompare(a.displayName, undefined, { sensitivity: "base" }),
    "size-desc": (a, b) => b.sizeBytes - a.sizeBytes,
    "size-asc": (a, b) => a.sizeBytes - b.sizeBytes,
  };
  list = [...list].sort((a, b) => sorters[q.sort](a, b) || a.id.localeCompare(b.id));

  const total = list.length;
  const start = (q.page - 1) * q.pageSize;
  return { items: list.slice(start, start + q.pageSize), total };
}
