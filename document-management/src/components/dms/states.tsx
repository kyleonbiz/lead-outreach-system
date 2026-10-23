import { AlertCircle, FileSearch, FolderOpen, Inbox, RefreshCw, Star, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function EmptyState({
  variant,
  onUpload,
  onClearFilters,
}: {
  variant: "folder" | "search" | "starred" | "trash" | "recent" | "all";
  onUpload?: () => void;
  onClearFilters?: () => void;
}) {
  const copy = {
    all: { Icon: Inbox, title: "No documents yet", body: "Upload your first document to get started." },
    folder: { Icon: FolderOpen, title: "This folder is empty", body: "Upload a document or move one here from another folder." },
    search: { Icon: FileSearch, title: "No matching documents", body: "Try a different search term or clear your filters." },
    starred: { Icon: Star, title: "No starred documents", body: "Star important documents to find them quickly." },
    trash: { Icon: Trash2, title: "Trash is empty", body: "Deleted documents appear here until you remove them permanently." },
    recent: { Icon: Inbox, title: "Nothing uploaded recently", body: "Documents from the last 30 days appear here." },
  }[variant];
  return (
    <div
      className="flex flex-col items-center justify-center rounded-2xl border border-dashed bg-muted/30 px-6 py-14 text-center"
      data-testid="empty-state"
    >
      <span className="flex size-14 items-center justify-center rounded-2xl bg-accent text-violet-500">
        <copy.Icon className="size-7" aria-hidden />
      </span>
      <h3 className="mt-4 text-base font-semibold">{copy.title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{copy.body}</p>
      <div className="mt-5 flex gap-2">
        {variant === "search" && onClearFilters && (
          <Button variant="outline" onClick={onClearFilters}>
            Clear filters
          </Button>
        )}
        {(variant === "all" || variant === "folder") && onUpload && (
          <Button variant="gradient" onClick={onUpload}>
            <Upload /> Upload documents
          </Button>
        )}
      </div>
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-2xl border border-red-200 bg-red-50/60 px-6 py-12 text-center"
      data-testid="error-state"
    >
      <span className="flex size-12 items-center justify-center rounded-2xl bg-red-100 text-destructive">
        <AlertCircle className="size-6" aria-hidden />
      </span>
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <Button variant="outline" className="mt-5" onClick={onRetry}>
          <RefreshCw /> Try again
        </Button>
      )}
    </div>
  );
}

export function LoadingSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div role="status" aria-label="Loading documents" className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex gap-3">
            <Skeleton className="size-11 rounded-xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-14" />
          </div>
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
