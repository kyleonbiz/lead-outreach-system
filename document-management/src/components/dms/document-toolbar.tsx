"use client";

import { Clock, FileStack, Star, Trash2, type LucideIcon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CATEGORIES, CATEGORY_LABELS, type DocumentQuery, type DocumentSort, type DocumentView } from "@/lib/dms/types";
import { FILE_TYPE_GROUPS } from "@/lib/dms/validation";
import { cn } from "@/lib/utils";
import { DocumentSearch } from "./document-search";

const VIEWS: { id: DocumentView; label: string; Icon: LucideIcon }[] = [
  { id: "all", label: "All", Icon: FileStack },
  { id: "recent", label: "Recent", Icon: Clock },
  { id: "starred", label: "Starred", Icon: Star },
  { id: "trash", label: "Trash", Icon: Trash2 },
];

const SORTS: { id: DocumentSort; label: string }[] = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "name-asc", label: "Name A–Z" },
  { id: "name-desc", label: "Name Z–A" },
  { id: "size-desc", label: "Largest first" },
  { id: "size-asc", label: "Smallest first" },
];

const ANY = "__any__";

export function DocumentToolbar({
  query,
  tags,
  trashCount,
  onChange,
}: {
  query: DocumentQuery;
  tags: string[];
  trashCount: number;
  onChange: (patch: Partial<DocumentQuery>) => void;
}) {
  return (
    <div className="space-y-3" role="search" aria-label="Filter documents">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div
          role="group"
          aria-label="Document view"
          className="flex w-full gap-1 overflow-x-auto rounded-xl bg-muted p-1 lg:w-auto"
        >
          {VIEWS.map(({ id, label, Icon }) => {
            const active = query.view === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                onClick={() => onChange({ view: id })}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors lg:flex-none",
                  active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4", active && id === "starred" && "fill-amber-400 text-amber-500")} aria-hidden />
                {label}
                {id === "trash" && trashCount > 0 && (
                  <span className="rounded-full bg-secondary px-1.5 text-[10px] tabular-nums">{trashCount}</span>
                )}
              </button>
            );
          })}
        </div>
        <div className="lg:w-80">
          <DocumentSearch value={query.search} onChange={(search) => onChange({ search })} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Select value={query.category ?? ANY} onValueChange={(v) => onChange({ category: v === ANY ? null : (v as DocumentQuery["category"]) })}>
          <SelectTrigger aria-label="Filter by category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={query.fileType ?? ANY} onValueChange={(v) => onChange({ fileType: v === ANY ? null : v })}>
          <SelectTrigger aria-label="Filter by file type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All file types</SelectItem>
            {FILE_TYPE_GROUPS.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.label}
              </SelectItem>
            ))}
            <SelectItem value="other">Other</SelectItem>
          </SelectContent>
        </Select>
        <Select value={query.tag ?? ANY} onValueChange={(v) => onChange({ tag: v === ANY ? null : v })}>
          <SelectTrigger aria-label="Filter by tag">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All tags</SelectItem>
            {tags.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={query.sort} onValueChange={(v) => onChange({ sort: v as DocumentSort })}>
          <SelectTrigger aria-label="Sort documents">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
