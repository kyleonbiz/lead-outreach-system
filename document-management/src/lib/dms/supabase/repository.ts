import type { SupabaseClient } from "@supabase/supabase-js";
import { DmsError } from "../errors";
import type {
  AuditEntry,
  BeginUploadArgs,
  BeginUploadResult,
  DocumentPatch,
  DocumentRepository,
  TeamRepository,
} from "../ports";
import type {
  DocumentQuery,
  DocumentRecord,
  DocumentVersion,
  Folder,
  FolderColor,
  FolderWithCount,
  Invite,
  Member,
  Role,
  ShareLinkInfo,
  StorageUsage,
  Workspace,
} from "../types";
import { documentFromRow, folderFromRow, mapDbError, versionFromRow } from "./mappers";

/**
 * Audit rows are written by the database itself (triggers, and the member/share
 * RPCs). Only these events need an explicit RPC call from the app.
 */
const RPC_AUDITED = new Set(["document.downloaded", "document.shared", "document.tags_updated"]);

/**
 * Runs every statement as the signed-in user, so Postgres RLS is the tenant
 * boundary. Never construct this with a service-role client.
 */
export class SupabaseRepository implements DocumentRepository, TeamRepository {
  constructor(private readonly db: SupabaseClient) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) throw mapDbError(error);
    return data as T;
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | null> {
    const { data, error } = await this.db
      .from("workspaces")
      .select("id,name,storage_quota_bytes")
      .eq("id", workspaceId)
      .maybeSingle();
    if (error) throw mapDbError(error);
    return data
      ? { id: data.id, name: data.name, storageQuotaBytes: Number(data.storage_quota_bytes) }
      : null;
  }

  async listFolders(ws: string): Promise<FolderWithCount[]> {
    const [folders, counts] = await Promise.all([
      this.db
        .from("document_folders")
        .select("*")
        .eq("workspace_id", ws)
        .order("is_system", { ascending: false })
        .order("created_at", { ascending: true }),
      this.rpc<{ folder_id: string; n: number }[]>("dms_folder_counts", { p_workspace: ws }),
    ]);
    if (folders.error) throw mapDbError(folders.error);
    const byId = new Map(counts.map((c) => [c.folder_id, Number(c.n)]));
    return (folders.data ?? []).map((r) => ({ ...folderFromRow(r), documentCount: byId.get(r.id) ?? 0 }));
  }

  async getFolder(ws: string, id: string): Promise<Folder | null> {
    const { data, error } = await this.db
      .from("document_folders")
      .select("*")
      .eq("id", id)
      .eq("workspace_id", ws)
      .maybeSingle();
    if (error) throw mapDbError(error);
    return data ? folderFromRow(data) : null;
  }

  async createFolder(a: { workspaceId: string; name: string; color: FolderColor; userId: string }) {
    const { data, error } = await this.db
      .from("document_folders")
      .insert({ workspace_id: a.workspaceId, name: a.name, color: a.color, created_by: a.userId, is_system: false })
      .select("*")
      .single();
    if (error) throw mapDbError(error);
    return folderFromRow(data);
  }

  async renameFolder(ws: string, id: string, name: string) {
    const { data, error } = await this.db
      .from("document_folders")
      .update({ name })
      .eq("id", id)
      .eq("workspace_id", ws)
      .select("*")
      .maybeSingle();
    if (error) throw mapDbError(error);
    if (!data) throw new DmsError("not_found", "Folder not found.");
    return folderFromRow(data);
  }

  async deleteFolder(ws: string, id: string) {
    const { data, error } = await this.db
      .from("document_folders")
      .delete()
      .eq("id", id)
      .eq("workspace_id", ws)
      .select("id");
    if (error) throw mapDbError(error);
    if (!data?.length) throw new DmsError("not_found", "Folder not found.");
  }

  listTags(ws: string) {
    return this.rpc<string[]>("dms_list_tags", { p_workspace: ws });
  }

  async queryDocuments(ws: string, q: DocumentQuery) {
    const rows = await this.rpc<{ doc: Record<string, unknown>; total: number }[]>("dms_query_documents", {
      p_workspace: ws,
      p_view: q.view,
      p_folder: q.folderId,
      p_search: q.search,
      p_category: q.category,
      p_file_type: q.fileType,
      p_tag: q.tag,
      p_sort: q.sort,
      p_page: q.page,
      p_size: q.pageSize,
    });
    return {
      items: rows.map((r) => documentFromRow(r.doc)),
      total: rows.length ? Number(rows[0].total) : 0,
    };
  }

  async getDocument(ws: string, id: string): Promise<DocumentRecord | null> {
    const row = await this.rpc<Record<string, unknown> | null>("dms_get_document", {
      p_workspace: ws,
      p_document: id,
    });
    return row ? documentFromRow(row) : null;
  }

  async listVersions(ws: string, documentId: string): Promise<DocumentVersion[]> {
    const { data, error } = await this.db
      .from("document_versions")
      .select("*")
      .eq("workspace_id", ws)
      .eq("document_id", documentId)
      .eq("status", "ready")
      .order("version_number", { ascending: false });
    if (error) throw mapDbError(error);
    return (data ?? []).map((r) => {
      const { status: _s, ...v } = versionFromRow(r);
      void _s;
      return v;
    });
  }

  async beginUpload(a: BeginUploadArgs): Promise<BeginUploadResult> {
    // The service builds keys as <ws>/<doc>/v<n>-<nonce>.<ext>; the database
    // assigns n under a lock, so we only pass the nonce and extension.
    const m = /\/v1-([A-Za-z0-9-]+)\.([a-z0-9]+)$/.exec(a.storageKey(1));
    if (!m) throw new DmsError("internal", "Could not prepare the upload.");
    const out = await this.rpc<{ document: Record<string, unknown>; version: Record<string, unknown> }>(
      "dms_begin_upload",
      {
        p_workspace: a.workspaceId,
        p_document: a.documentId,
        p_new_document: a.newDocumentId,
        p_original_name: a.originalName,
        p_display_name: a.displayName,
        p_folder: a.folderId,
        p_category: a.category,
        p_mime: a.mimeType,
        p_size: a.sizeBytes,
        p_nonce: m[1],
        p_ext: m[2],
        p_user_name: a.userName,
      },
    );
    const { status: _s, ...version } = versionFromRow(out.version);
    void _s;
    return { document: documentFromRow(out.document), version };
  }

  async getVersion(ws: string, documentId: string, versionNumber: number) {
    const { data, error } = await this.db
      .from("document_versions")
      .select("*")
      .eq("workspace_id", ws)
      .eq("document_id", documentId)
      .eq("version_number", versionNumber)
      .maybeSingle();
    if (error) throw mapDbError(error);
    return data ? versionFromRow(data) : null;
  }

  async completeUpload(a: {
    workspaceId: string;
    documentId: string;
    versionNumber: number;
    sizeBytes: number;
    mimeType: string;
  }) {
    const row = await this.rpc<Record<string, unknown>>("dms_complete_upload", {
      p_workspace: a.workspaceId,
      p_document: a.documentId,
      p_version: a.versionNumber,
      p_size: a.sizeBytes,
      p_mime: a.mimeType,
    });
    const doc = await this.getDocument(a.workspaceId, a.documentId);
    return doc ?? documentFromRow(row);
  }

  abortUpload(ws: string, documentId: string, versionNumber: number) {
    return this.rpc<string | null>("dms_abort_upload", {
      p_workspace: ws,
      p_document: documentId,
      p_version: versionNumber,
    });
  }

  async updateDocument(ws: string, id: string, patch: DocumentPatch) {
    const row: Record<string, unknown> = {};
    if (patch.displayName !== undefined) row.display_name = patch.displayName;
    if (patch.folderId !== undefined) row.folder_id = patch.folderId;
    if (patch.starred !== undefined) row.starred = patch.starred;
    if (patch.category !== undefined) row.category = patch.category;
    if (patch.expiresAt !== undefined) row.expires_at = patch.expiresAt;
    return this.writeAndReload(ws, id, row);
  }

  private async writeAndReload(ws: string, id: string, row: Record<string, unknown>) {
    const { data, error } = await this.db
      .from("documents")
      .update(row)
      .eq("id", id)
      .eq("workspace_id", ws)
      .select("id");
    if (error) throw mapDbError(error);
    if (!data?.length) throw new DmsError("not_found", "Document not found.");
    const doc = await this.getDocument(ws, id);
    if (!doc) throw new DmsError("not_found", "Document not found.");
    return doc;
  }

  setTags(ws: string, id: string, tags: string[]) {
    return this.rpc<string[]>("dms_set_tags", { p_workspace: ws, p_document: id, p_tags: tags });
  }

  softDelete(ws: string, id: string) {
    return this.writeAndReload(ws, id, { deleted_at: new Date().toISOString() });
  }

  restore(ws: string, id: string) {
    return this.writeAndReload(ws, id, { deleted_at: null });
  }

  purge(ws: string, id: string) {
    return this.rpc<string[]>("dms_purge_document", { p_workspace: ws, p_document: id });
  }

  async getUsage(ws: string): Promise<StorageUsage> {
    const u = await this.rpc<{ usedBytes: number; quotaBytes: number; documentCount: number }>("dms_usage", {
      p_workspace: ws,
    });
    return {
      usedBytes: Number(u.usedBytes),
      quotaBytes: Number(u.quotaBytes),
      documentCount: Number(u.documentCount),
    };
  }

  async countTrash(ws: string) {
    const u = await this.rpc<{ trashCount: number }>("dms_usage", { p_workspace: ws });
    return Number(u.trashCount);
  }

  async createShareLink(a: {
    workspaceId: string;
    documentId: string;
    tokenHash: string;
    expiresAt: string;
    userId: string;
  }) {
    const { error } = await this.db.from("document_share_links").insert({
      workspace_id: a.workspaceId,
      document_id: a.documentId,
      token_hash: a.tokenHash,
      expires_at: a.expiresAt,
      created_by: a.userId,
    });
    if (error) throw mapDbError(error);
  }

  async listShareLinks(ws: string, documentId: string): Promise<ShareLinkInfo[]> {
    const rows = await this.rpc<
      { id: string; created_at: string; expires_at: string; created_by: string | null; created_by_name: string }[]
    >("dms_list_share_links", { p_workspace: ws, p_document: documentId });
    return (rows ?? []).map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      createdBy: r.created_by ?? "",
      createdByName: r.created_by_name ?? "",
    }));
  }

  async revokeShareLink(ws: string, linkId: string) {
    await this.rpc("dms_revoke_share_link", { p_workspace: ws, p_link: linkId });
  }

  /* ------------------------------ team ------------------------------ */

  async listMembers(ws: string): Promise<Member[]> {
    const { data, error } = await this.db
      .from("workspace_members")
      .select("user_id,display_name,email,role,created_at")
      .eq("workspace_id", ws)
      .order("created_at", { ascending: true });
    if (error) throw mapDbError(error);
    return (data ?? []).map((r) => ({
      userId: r.user_id,
      displayName: r.display_name ?? "",
      email: r.email ?? "",
      role: r.role as Role,
      joinedAt: r.created_at,
    }));
  }

  async listInvites(ws: string): Promise<Invite[]> {
    const { data, error } = await this.db
      .from("workspace_invites")
      .select("id,email,role,created_at,expires_at")
      .eq("workspace_id", ws)
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });
    if (error) throw mapDbError(error);
    return (data ?? []).map(inviteFromRow);
  }

  async createInvite(a: { workspaceId: string; userId: string; email: string; role: Role }): Promise<Invite> {
    const id = await this.rpc<string>("dms_invite_member", {
      p_workspace: a.workspaceId,
      p_email: a.email,
      p_role: a.role,
    });
    const { data, error } = await this.db
      .from("workspace_invites")
      .select("id,email,role,created_at,expires_at")
      .eq("id", id)
      .single();
    if (error) throw mapDbError(error);
    return inviteFromRow(data);
  }

  async revokeInvite(ws: string, inviteId: string): Promise<Invite | null> {
    await this.rpc("dms_revoke_invite", { p_workspace: ws, p_invite: inviteId });
    return null;
  }

  async setMemberRole(ws: string, userId: string, role: Role) {
    await this.rpc("dms_set_member_role", { p_workspace: ws, p_user: userId, p_role: role });
  }

  async removeMember(ws: string, userId: string) {
    await this.rpc("dms_remove_member", { p_workspace: ws, p_user: userId });
  }

  async recordAudit(ws: string, _userId: string, entry: AuditEntry) {
    if (!RPC_AUDITED.has(entry.action) || !entry.entityId) return; // others are written by DB triggers
    await this.rpc("dms_record_audit", {
      p_workspace: ws,
      p_action: entry.action,
      p_entity: entry.entityId,
      p_meta: entry.metadata ?? {},
    });
  }
}

function inviteFromRow(r: { id: string; email: string; role: string; created_at: string; expires_at: string }): Invite {
  return { id: r.id, email: r.email, role: r.role as Role, invitedAt: r.created_at, expiresAt: r.expires_at };
}
