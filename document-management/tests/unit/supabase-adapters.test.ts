import { afterEach, describe, expect, it, vi } from "vitest";
import { DmsError } from "@/lib/dms/errors";
import { mapDbError } from "@/lib/dms/supabase/mappers";
import { SupabaseRepository } from "@/lib/dms/supabase/repository";
import { DOCUMENTS_BUCKET, SupabaseStorage } from "@/lib/dms/supabase/storage";
import { defaultQuery } from "@/lib/dms/validation";
import { fakeStorageClient, fakeSupabase } from "../support/fake-supabase";

const WS = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const docRow = (over: Record<string, unknown> = {}) => ({
  id: DOC, workspace_id: WS, folder_id: null, original_name: "a.pdf", display_name: "a.pdf",
  storage_key: `${WS}/${DOC}/v1-abc.pdf`, mime_type: "application/pdf", size_bytes: "1000", category: "invoice",
  tags: ["Q4"], uploaded_by: USER, uploaded_by_name: "Kyle", created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z", expires_at: null, starred: false, status: "ready", deleted_at: null,
  current_version: 1, ...over,
});
const versionRow = (over: Record<string, unknown> = {}) => ({
  id: "44444444-4444-4444-8444-444444444444", document_id: DOC, workspace_id: WS, version_number: 1,
  storage_key: `${WS}/${DOC}/v1-abc.pdf`, mime_type: "application/pdf", size_bytes: 1000, status: "ready",
  created_by: USER, created_by_name: "Kyle", created_at: "2026-10-01T00:00:00Z", ...over,
});

const err = (code: string, message = "") => ({ error: { code, message } });
const caught = async (p: Promise<unknown>) => p.then(() => null, (e) => e as DmsError);

afterEach(() => vi.restoreAllMocks());

describe("SupabaseRepository: documents", () => {
  it("passes every filter to dms_query_documents and maps rows and total", async () => {
    const { client, rpcCalls } = fakeSupabase({
      rpc: { dms_query_documents: { data: [{ doc: docRow(), total: "7" }, { doc: docRow({ id: "x" }), total: "7" }] } },
    });
    const res = await new SupabaseRepository(client).queryDocuments(WS, {
      ...defaultQuery(), view: "starred", folderId: DOC, search: "inv", category: "invoice", fileType: "pdf", tag: "Q4",
      sort: "name-asc", page: 2, pageSize: 5,
    });
    expect(rpcCalls("dms_query_documents")[0].args).toEqual({
      p_workspace: WS, p_view: "starred", p_folder: DOC, p_search: "inv", p_category: "invoice",
      p_file_type: "pdf", p_tag: "Q4", p_sort: "name-asc", p_page: 2, p_size: 5,
    });
    expect(res.total).toBe(7);
    expect(res.items[0]).toMatchObject({ id: DOC, sizeBytes: 1000, tags: ["Q4"], uploadedByName: "Kyle", currentVersion: 1 });
  });
  it("returns total 0 for an empty page and null for a missing document", async () => {
    const { client } = fakeSupabase({ rpc: { dms_query_documents: { data: [] }, dms_get_document: { data: null } } });
    const repo = new SupabaseRepository(client);
    expect(await repo.queryDocuments(WS, defaultQuery())).toEqual({ items: [], total: 0 });
    expect(await repo.getDocument(WS, DOC)).toBeNull();
  });
  it("maps database errors instead of leaking them", async () => {
    const { client } = fakeSupabase({ rpc: { dms_query_documents: err("XX000", "relation secret_table does not exist") } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = await caught(new SupabaseRepository(client).queryDocuments(WS, defaultQuery()));
    expect(e).toBeInstanceOf(DmsError);
    expect(e?.code).toBe("internal");
    expect(e?.message).not.toMatch(/secret_table/);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret_table/); // only the SQLSTATE is logged
  });

  it("begins an upload by sending only the nonce/extension; the database picks the version", async () => {
    const { client, rpcCalls } = fakeSupabase({
      rpc: { dms_begin_upload: { data: { document: docRow({ status: "pending", current_version: 0 }), version: versionRow({ status: "pending" }) } } },
    });
    const out = await new SupabaseRepository(client).beginUpload({
      workspaceId: WS, userId: USER, userName: "Kyle", documentId: null, newDocumentId: DOC, originalName: "a.pdf",
      displayName: "a.pdf", folderId: null, category: "invoice", mimeType: "application/pdf", sizeBytes: 1000,
      storageKey: (v) => `${WS}/${DOC}/v${v}-nonce123.pdf`,
    });
    expect(rpcCalls("dms_begin_upload")[0].args).toMatchObject({
      p_workspace: WS, p_document: null, p_new_document: DOC, p_nonce: "nonce123", p_ext: "pdf", p_size: 1000, p_user_name: "Kyle",
    });
    expect(out.version).not.toHaveProperty("status");
    expect(out.version.storageKey).toContain("/v1-abc.pdf");
  });
  it("surfaces quota errors from the atomic reservation", async () => {
    const { client } = fakeSupabase({ rpc: { dms_begin_upload: err("P0001", "quota_exceeded") } });
    const e = await caught(
      new SupabaseRepository(client).beginUpload({
        workspaceId: WS, userId: USER, userName: "K", documentId: null, newDocumentId: DOC, originalName: "a.pdf", displayName: "a.pdf",
        folderId: null, category: "other", mimeType: "application/pdf", sizeBytes: 1, storageKey: (v) => `${WS}/${DOC}/v${v}-n.pdf`,
      }),
    );
    expect(e?.code).toBe("quota_exceeded");
  });

  it("updates with column names, scopes by workspace, and reloads", async () => {
    const { client, fromCalls } = fakeSupabase({
      from: { documents: { data: [{ id: DOC }] } },
      rpc: { dms_get_document: { data: docRow({ display_name: "b.pdf", starred: true }) } },
    });
    const doc = await new SupabaseRepository(client).updateDocument(WS, DOC, {
      displayName: "b.pdf", folderId: null, starred: true, category: "tax", expiresAt: "2027-01-01T00:00:00Z",
    });
    const ops = fromCalls("documents")[0].ops;
    expect(ops[0]).toEqual(["update", [{ display_name: "b.pdf", folder_id: null, starred: true, category: "tax", expires_at: "2027-01-01T00:00:00Z" }]]);
    expect(ops).toContainEqual(["eq", ["id", DOC]]);
    expect(ops).toContainEqual(["eq", ["workspace_id", WS]]);
    expect(doc.displayName).toBe("b.pdf");
  });
  it("treats an update that touched no row (RLS or wrong workspace) as not found", async () => {
    const { client } = fakeSupabase({ from: { documents: { data: [] } } });
    expect((await caught(new SupabaseRepository(client).updateDocument(WS, DOC, { starred: true })))?.code).toBe("not_found");
  });
  it("maps protected-column rejections to forbidden", async () => {
    const { client } = fakeSupabase({ from: { documents: err("42501", "protected_column") } });
    expect((await caught(new SupabaseRepository(client).updateDocument(WS, DOC, { starred: true })))?.code).toBe("forbidden");
  });
  it("soft-deletes with a timestamp and restores with null", async () => {
    const { client, fromCalls } = fakeSupabase({
      from: { documents: { data: [{ id: DOC }] } },
      rpc: { dms_get_document: { data: docRow() } },
    });
    const repo = new SupabaseRepository(client);
    await repo.softDelete(WS, DOC);
    await repo.restore(WS, DOC);
    const [del, res] = fromCalls("documents").map((c) => (c.ops[0][1][0] as { deleted_at: string | null }).deleted_at);
    expect(new Date(del as string).getTime()).toBeGreaterThan(0);
    expect(res).toBeNull();
  });
  it("sets tags and purges through RPCs, returning storage keys", async () => {
    const { client, rpcCalls } = fakeSupabase({
      rpc: { dms_set_tags: { data: ["A", "B"] }, dms_purge_document: { data: ["k1", "k2"] }, dms_list_tags: { data: ["A"] } },
    });
    const repo = new SupabaseRepository(client);
    expect(await repo.setTags(WS, DOC, ["A", "B"])).toEqual(["A", "B"]);
    expect(rpcCalls("dms_set_tags")[0].args).toEqual({ p_workspace: WS, p_document: DOC, p_tags: ["A", "B"] });
    expect(await repo.purge(WS, DOC)).toEqual(["k1", "k2"]);
    expect(await repo.listTags(WS)).toEqual(["A"]);
  });
  it("maps usage and trash counts", async () => {
    const { client } = fakeSupabase({ rpc: { dms_usage: { data: { usedBytes: "10", quotaBytes: "100", documentCount: "2", trashCount: "3" } } } });
    const repo = new SupabaseRepository(client);
    expect(await repo.getUsage(WS)).toEqual({ usedBytes: 10, quotaBytes: 100, documentCount: 2 });
    expect(await repo.countTrash(WS)).toBe(3);
  });
  it("lists only ready versions, newest first, without the internal status field", async () => {
    const { client, fromCalls } = fakeSupabase({ from: { document_versions: { data: [versionRow({ version_number: 2 }), versionRow()] } } });
    const out = await new SupabaseRepository(client).listVersions(WS, DOC);
    expect(fromCalls("document_versions")[0].ops).toContainEqual(["eq", ["status", "ready"]]);
    expect(out.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(out[0]).not.toHaveProperty("status");
  });
  it("getVersion keeps the status so finalize can tell pending from ready", async () => {
    const { client } = fakeSupabase({ from: { document_versions: { data: versionRow({ status: "pending" }) } } });
    expect((await new SupabaseRepository(client).getVersion(WS, DOC, 1))?.status).toBe("pending");
  });
  it("completes uploads via the RPC and aborts via the RPC (returning the key to delete)", async () => {
    const { client, rpcCalls } = fakeSupabase({
      rpc: { dms_complete_upload: { data: docRow() }, dms_get_document: { data: docRow() }, dms_abort_upload: { data: "key-to-delete" } },
    });
    const repo = new SupabaseRepository(client);
    await repo.completeUpload({ workspaceId: WS, documentId: DOC, versionNumber: 1, sizeBytes: 1000, mimeType: "application/pdf" });
    expect(rpcCalls("dms_complete_upload")[0].args).toEqual({ p_workspace: WS, p_document: DOC, p_version: 1, p_size: 1000, p_mime: "application/pdf" });
    expect(await repo.abortUpload(WS, DOC, 1)).toBe("key-to-delete");
  });
});

describe("SupabaseRepository: folders, shares, audit", () => {
  it("merges folder rows with per-folder counts", async () => {
    const f = (id: string) => ({ id, workspace_id: WS, name: id, color: "violet", is_system: false, default_category: null, created_at: "2026-01-01T00:00:00Z" });
    const { client } = fakeSupabase({
      from: { document_folders: { data: [f("a"), f("b")] } },
      rpc: { dms_folder_counts: { data: [{ folder_id: "a", n: "4" }] } },
    });
    const out = await new SupabaseRepository(client).listFolders(WS);
    expect(out.map((x) => x.documentCount)).toEqual([4, 0]);
  });
  it("creates folders owned by the caller and never as system folders", async () => {
    const { client, fromCalls } = fakeSupabase({
      from: { document_folders: { data: { id: "n", workspace_id: WS, name: "Clients", color: "sky", is_system: false, default_category: null, created_at: "2026-01-01T00:00:00Z" } } },
    });
    await new SupabaseRepository(client).createFolder({ workspaceId: WS, name: "Clients", color: "sky", userId: USER });
    expect(fromCalls("document_folders")[0].ops[0]).toEqual(["insert", [{ workspace_id: WS, name: "Clients", color: "sky", created_by: USER, is_system: false }]]);
  });
  it("reports not found when a folder delete or rename matched nothing", async () => {
    const { client } = fakeSupabase({ from: { document_folders: { data: [] } } });
    const repo = new SupabaseRepository(client);
    expect((await caught(repo.deleteFolder(WS, DOC)))?.code).toBe("not_found");
    const { client: c2 } = fakeSupabase({ from: { document_folders: { data: null } } });
    expect((await caught(new SupabaseRepository(c2).renameFolder(WS, DOC, "x")))?.code).toBe("not_found");
  });
  it("stores only a token hash for share links", async () => {
    const { client, fromCalls } = fakeSupabase({ from: { document_share_links: { data: null } } });
    await new SupabaseRepository(client).createShareLink({ workspaceId: WS, documentId: DOC, tokenHash: "h".repeat(64), expiresAt: "2026-11-01T00:00:00Z", userId: USER });
    const [, [row]] = fromCalls("document_share_links")[0].ops[0] as [string, [Record<string, unknown>]];
    expect(row).toEqual({ workspace_id: WS, document_id: DOC, token_hash: "h".repeat(64), expires_at: "2026-11-01T00:00:00Z", created_by: USER });
    expect(JSON.stringify(row)).not.toMatch(/token"/);
  });
  it("lists and revokes share links through RPCs", async () => {
    const { client, rpcCalls } = fakeSupabase({
      rpc: {
        dms_list_share_links: { data: [{ id: "l1", created_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-02T00:00:00Z", created_by: USER, created_by_name: "Kyle" }] },
        dms_revoke_share_link: { data: null },
      },
    });
    const repo = new SupabaseRepository(client);
    expect(await repo.listShareLinks(WS, DOC)).toEqual([
      { id: "l1", createdAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-02T00:00:00Z", createdBy: USER, createdByName: "Kyle" },
    ]);
    await repo.revokeShareLink(WS, "l1");
    expect(rpcCalls("dms_revoke_share_link")[0].args).toEqual({ p_workspace: WS, p_link: "l1" });
  });
  it("only calls the audit RPC for events the database cannot see itself", async () => {
    const { client, rpcCalls } = fakeSupabase({ rpc: { dms_record_audit: { data: null } } });
    const repo = new SupabaseRepository(client);
    for (const action of ["document.renamed", "document.moved", "member.invited", "document.share_revoked", "folder.created"]) {
      await repo.recordAudit(WS, USER, { action, entityType: "document", entityId: DOC });
    }
    expect(rpcCalls("dms_record_audit")).toHaveLength(0); // written by triggers / RPCs in the database
    await repo.recordAudit(WS, USER, { action: "document.downloaded", entityType: "document", entityId: DOC, metadata: { version: 2 } });
    expect(rpcCalls("dms_record_audit")[0].args).toEqual({ p_workspace: WS, p_action: "document.downloaded", p_entity: DOC, p_meta: { version: 2 } });
  });
});

describe("SupabaseRepository: team", () => {
  it("lists members and unaccepted, unexpired invites", async () => {
    const { client, fromCalls } = fakeSupabase({
      from: {
        workspace_members: { data: [{ user_id: USER, display_name: null, email: "k@a.test", role: "owner", created_at: "2026-01-01T00:00:00Z" }] },
        workspace_invites: { data: [{ id: "i1", email: "n@a.test", role: "editor", created_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-15T00:00:00Z" }] },
      },
    });
    const repo = new SupabaseRepository(client);
    expect(await repo.listMembers(WS)).toEqual([{ userId: USER, displayName: "", email: "k@a.test", role: "owner", joinedAt: "2026-01-01T00:00:00Z" }]);
    expect(await repo.listInvites(WS)).toEqual([{ id: "i1", email: "n@a.test", role: "editor", invitedAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-15T00:00:00Z" }]);
    const ops = fromCalls("workspace_invites")[0].ops;
    expect(ops).toContainEqual(["is", ["accepted_at", null]]);
    expect(ops.some(([op]) => op === "gt")).toBe(true);
  });
  it("creates an invite through the RPC and reads it back", async () => {
    const { client, rpcCalls } = fakeSupabase({
      rpc: { dms_invite_member: { data: "i1" } },
      from: { workspace_invites: { data: { id: "i1", email: "n@a.test", role: "editor", created_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-15T00:00:00Z" } } },
    });
    const inv = await new SupabaseRepository(client).createInvite({ workspaceId: WS, userId: USER, email: "n@a.test", role: "editor" });
    expect(rpcCalls("dms_invite_member")[0].args).toEqual({ p_workspace: WS, p_email: "n@a.test", p_role: "editor" });
    expect(inv.id).toBe("i1");
  });
  it("changes roles, removes members and revokes invites only through RPCs", async () => {
    const { client, rpcCalls, fromCalls } = fakeSupabase({ rpc: { dms_set_member_role: {}, dms_remove_member: {}, dms_revoke_invite: {} } });
    const repo = new SupabaseRepository(client);
    await repo.setMemberRole(WS, USER, "viewer");
    await repo.removeMember(WS, USER);
    await repo.revokeInvite(WS, "i1");
    expect(rpcCalls("dms_set_member_role")[0].args).toEqual({ p_workspace: WS, p_user: USER, p_role: "viewer" });
    expect(rpcCalls("dms_remove_member")[0].args).toEqual({ p_workspace: WS, p_user: USER });
    expect(rpcCalls("dms_revoke_invite")[0].args).toEqual({ p_workspace: WS, p_invite: "i1" });
    expect(fromCalls("workspace_members")).toHaveLength(0); // no direct table writes
  });
  it("maps team rule violations from the database", async () => {
    const { client } = fakeSupabase({ rpc: { dms_remove_member: err("P0001", "last_owner"), dms_invite_member: err("23505", "conflict"), dms_set_member_role: err("42501", "forbidden") } });
    const repo = new SupabaseRepository(client);
    expect((await caught(repo.removeMember(WS, USER)))?.message).toMatch(/at least one owner/);
    expect((await caught(repo.createInvite({ workspaceId: WS, userId: USER, email: "a@b.test", role: "viewer" })))?.code).toBe("conflict");
    expect((await caught(repo.setMemberRole(WS, USER, "owner")))?.code).toBe("forbidden");
  });
});

describe("mapDbError", () => {
  it.each([
    [{ code: "P0001", message: "quota_exceeded" }, "quota_exceeded"],
    [{ code: "42501", message: "permission denied" }, "forbidden"],
    [{ code: "P0002", message: "not_found" }, "not_found"],
    [{ code: "23503", message: "fk" }, "not_found"],
    [{ code: "23505", message: "dup" }, "conflict"],
    [{ code: "40001", message: "conflict" }, "conflict"],
    [{ code: "22023", message: "invalid_role" }, "validation"],
    [{ code: "23514", message: "check" }, "validation"],
    [{ code: "PGRST301", message: "JWT expired" }, "unauthenticated"],
  ])("%j -> %s", (input, expected) => {
    expect(mapDbError(input).code).toBe(expected);
  });
  it("hides unknown errors behind a generic message", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const e = mapDbError({ code: "XX000", message: "password=hunter2 in row" });
    expect(e.code).toBe("internal");
    expect(e.message).not.toContain("hunter2");
  });
});

describe("SupabaseStorage", () => {
  it("opens a signed upload target in the private bucket", async () => {
    const { client, from, bucket } = fakeStorageClient();
    const t = await new SupabaseStorage(client).createUploadTarget(`${WS}/${DOC}/v1-a.pdf`);
    expect(from).toHaveBeenCalledWith(DOCUMENTS_BUCKET);
    expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith(`${WS}/${DOC}/v1-a.pdf`);
    expect(t).toMatchObject({ kind: "supabase-signed", method: "PUT" });
    expect(t.url).toContain("token=");
  });
  it("fails closed when the signed upload URL cannot be created", async () => {
    const { client } = fakeStorageClient({ createSignedUploadUrl: vi.fn(async () => ({ data: null, error: { message: "boom" } })) });
    expect((await caught(new SupabaseStorage(client).createUploadTarget("k")))?.code).toBe("storage_failed");
  });
  it("stats an object and returns null when it is missing", async () => {
    const ok = fakeStorageClient();
    expect(await new SupabaseStorage(ok.client).stat("k")).toEqual({ sizeBytes: 1234, mimeType: "application/pdf" });
    const missing = fakeStorageClient({ info: vi.fn(async () => ({ data: null, error: { message: "nf" } })) });
    expect(await new SupabaseStorage(missing.client).stat("k")).toBeNull();
  });
  it("reads only the leading bytes through a short-lived signed URL", async () => {
    const { client, bucket } = fakeStorageClient();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18])));
    vi.stubGlobal("fetch", fetchMock);
    const head = await new SupabaseStorage(client).readHead("k", 8);
    expect(bucket.createSignedUrl).toHaveBeenCalledWith("k", 30);
    expect(fetchMock.mock.calls[0]).toEqual(["https://sb.test/sign/k", expect.objectContaining({ headers: { Range: "bytes=0-7" } })]);
    expect(head).toHaveLength(8);
    expect([...head!.slice(0, 4)]).toEqual([0x25, 0x50, 0x44, 0x46]);
    vi.unstubAllGlobals();
  });
  it("returns null from readHead on HTTP or network failure", async () => {
    const { client } = fakeStorageClient();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
    expect(await new SupabaseStorage(client).readHead("k", 8)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await new SupabaseStorage(client).readHead("k", 8)).toBeNull();
    vi.unstubAllGlobals();
  });
  it("signs downloads for the requested TTL, forcing a download name only for attachments", async () => {
    const { client, bucket } = fakeStorageClient();
    const s = new SupabaseStorage(client);
    const att = await s.createDownloadUrl("k", { fileName: "My File.pdf", disposition: "attachment", ttlSeconds: 60 });
    expect(bucket.createSignedUrl).toHaveBeenLastCalledWith("k", 60, { download: "My File.pdf" });
    expect(att.url).toMatch(/^https:\/\/sb\.test\/sign\//);
    expect(new Date(att.expiresAt).getTime()).toBeGreaterThan(Date.now());
    await s.createDownloadUrl("k", { fileName: "My File.pdf", disposition: "inline", ttlSeconds: 60 });
    expect(bucket.createSignedUrl).toHaveBeenLastCalledWith("k", 60, undefined);
  });
  it("reports a missing file as not found", async () => {
    const { client } = fakeStorageClient({ createSignedUrl: vi.fn(async () => ({ data: null, error: { message: "nf" } })) });
    expect((await caught(new SupabaseStorage(client).createDownloadUrl("k", { fileName: "f", disposition: "attachment", ttlSeconds: 60 })))?.code).toBe("not_found");
  });
  it("removes objects, skips empty lists and reports failures", async () => {
    const { client, bucket } = fakeStorageClient();
    const s = new SupabaseStorage(client);
    await s.remove([]);
    expect(bucket.remove).not.toHaveBeenCalled();
    await s.remove(["a", "b"]);
    expect(bucket.remove).toHaveBeenCalledWith(["a", "b"]);
    const bad = fakeStorageClient({ remove: vi.fn(async () => ({ data: null, error: { message: "x" } })) });
    expect((await caught(new SupabaseStorage(bad.client).remove(["a"])))?.code).toBe("storage_failed");
  });
});
