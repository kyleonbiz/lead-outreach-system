import { DmsError } from "../errors";
import type { Category, ContentStatus, DocumentRecord, DocumentVersion, Folder, FolderColor } from "../types";

type Row = Record<string, unknown>;

export function documentFromRow(r: Row): DocumentRecord {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    folderId: (r.folder_id as string | null) ?? null,
    originalName: r.original_name as string,
    displayName: r.display_name as string,
    storageKey: r.storage_key as string,
    mimeType: r.mime_type as string,
    sizeBytes: Number(r.size_bytes),
    category: r.category as Category,
    tags: (r.tags as string[] | undefined) ?? [],
    uploadedBy: (r.uploaded_by as string | null) ?? "",
    uploadedByName: (r.uploaded_by_name as string) ?? "",
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    expiresAt: (r.expires_at as string | null) ?? null,
    starred: Boolean(r.starred),
    status: r.status as "pending" | "ready",
    deletedAt: (r.deleted_at as string | null) ?? null,
    currentVersion: Number(r.current_version),
    contentStatus: ((r.content_status as ContentStatus | undefined) ?? "pending"),
    contentReason: (r.content_reason as string | null | undefined) ?? null,
    contentIndexedAt: (r.content_indexed_at as string | null | undefined) ?? null,
    ...(typeof r.content_match === "boolean"
      ? { contentMatch: r.content_match, snippet: (r.snippet as string | null | undefined) ?? null }
      : {}),
  };
}

export function versionFromRow(r: Row): DocumentVersion & { status: "pending" | "ready" } {
  return {
    id: r.id as string,
    documentId: r.document_id as string,
    versionNumber: Number(r.version_number),
    storageKey: r.storage_key as string,
    mimeType: r.mime_type as string,
    sizeBytes: Number(r.size_bytes),
    createdBy: (r.created_by as string | null) ?? "",
    createdByName: (r.created_by_name as string) ?? "",
    createdAt: r.created_at as string,
    status: r.status as "pending" | "ready",
  };
}

export function folderFromRow(r: Row): Folder {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    name: r.name as string,
    color: r.color as FolderColor,
    isSystem: Boolean(r.is_system),
    defaultCategory: (r.default_category as Category | null) ?? null,
    createdAt: r.created_at as string,
  };
}

/** Translates Postgres/PostgREST errors to DmsError without leaking internals. */
export function mapDbError(error: { code?: string; message?: string } | null | undefined): DmsError {
  const msg = error?.message ?? "";
  const code = error?.code ?? "";
  if (msg.includes("quota_exceeded")) return new DmsError("quota_exceeded", "Not enough storage left in this workspace.");
  if (msg.includes("workspace_limit")) return new DmsError("quota_exceeded", "You already own the maximum number of workspaces.");
  if (msg.includes("last_owner")) return new DmsError("conflict", "A workspace must keep at least one owner.");
  if (msg.includes("protected_column") || msg.includes("forbidden") || code === "42501") {
    return new DmsError("forbidden", "You do not have permission to do that.");
  }
  if (msg.includes("not_found") || code === "P0002" || code === "23503") {
    return new DmsError("not_found", "Not found.");
  }
  if (msg.includes("conflict") || code === "23505" || code === "40001") {
    return new DmsError("conflict", "That conflicts with an existing item.");
  }
  if (msg.includes("object_missing") || msg.includes("size_mismatch")) {
    return new DmsError("validation", "The uploaded file did not match what was declared.");
  }
  if (code === "22023" || code === "23514" || msg.includes("invalid_")) {
    return new DmsError("validation", "The request was not valid.");
  }
  if (code === "PGRST301" || code === "PGRST303" || msg.includes("JWT")) {
    return new DmsError("unauthenticated", "Please sign in again.");
  }
  // Only the code is logged: messages can embed row data.
  console.error("[dms] database error", code || "unknown");
  return new DmsError("internal", "Something went wrong. Please try again.");
}
