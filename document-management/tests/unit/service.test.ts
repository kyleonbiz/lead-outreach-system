import { beforeEach, describe, expect, it } from "vitest";
import { DmsError } from "@/lib/dms/errors";
import { can, dedupeTags, sha256Hex } from "@/lib/dms/service";
import { DOC_B, FOLDER_B, NOW, PDF_BYTES, WS_A, WS_B, makeWorld, uploadFile, type World } from "../support/world";

const DOC_INVOICE = "00000000-0000-4000-8000-000000000100"; // Invoice_INV-2041_Northwind.pdf (seed)
const FOLDER_INVOICES = "00000000-0000-4000-8000-000000000010";
const FOLDER_RECEIPTS = "00000000-0000-4000-8000-000000000011";

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => (e instanceof DmsError ? e.code : `other:${e?.name}`),
  );

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const init = (over = {}) => ({ fileName: "a.pdf", size: 100, mimeType: "application/pdf", folderId: null, ...over });

describe("roles and permissions", () => {
  it("maps roles to capabilities", () => {
    expect(can("viewer", "read")).toBe(true);
    expect(can("viewer", "write")).toBe(false);
    expect(can("editor", "write")).toBe(true);
    expect(can("editor", "purge")).toBe(false);
    expect(can("admin", "purge")).toBe(true);
  });
  it("viewers can read and download but not mutate", async () => {
    const v = w.as(WS_A, "viewer");
    expect((await v.listDocuments({})).total).toBe(18);
    await expect(v.getFileLink(DOC_INVOICE)).resolves.toHaveProperty("url");
    expect(await code(v.updateDocument(DOC_INVOICE, { starred: true }))).toBe("forbidden");
    expect(await code(v.deleteDocument(DOC_INVOICE))).toBe("forbidden");
    expect(await code(v.initiateUpload(init()))).toBe("forbidden");
    expect(await code(v.createFolder({ name: "X" }))).toBe("forbidden");
    expect(await code(v.createShareLink(DOC_INVOICE, 60))).toBe("forbidden");
  });
  it("editors cannot purge; admins can", async () => {
    const e = w.as(WS_A, "editor");
    await e.deleteDocument(DOC_INVOICE);
    expect(await code(e.purgeDocument(DOC_INVOICE))).toBe("forbidden");
    await expect(w.as(WS_A, "admin").purgeDocument(DOC_INVOICE)).resolves.toBeUndefined();
  });
});

describe("workspace isolation", () => {
  it("never lists another workspace's documents, folders or tags", async () => {
    const a = w.as(WS_A, "owner");
    const list = await a.listDocuments({ pageSize: 100 });
    expect(list.items.every((d) => d.workspaceId === WS_A)).toBe(true);
    expect(list.items.some((d) => d.id === DOC_B)).toBe(false);
    const boot = await a.bootstrap();
    expect(boot.folders.some((f) => f.id === FOLDER_B)).toBe(false);
    expect(boot.tags).not.toContain("Confidential");
    expect(boot.workspace.id).toBe(WS_A);
  });
  it("treats foreign ids as not found for every operation", async () => {
    const a = w.as(WS_A, "owner");
    for (const op of [
      () => a.getDocument(DOC_B),
      () => a.getFileLink(DOC_B),
      () => a.updateDocument(DOC_B, { starred: true }),
      () => a.deleteDocument(DOC_B),
      () => a.restoreDocument(DOC_B),
      () => a.purgeDocument(DOC_B),
      () => a.createShareLink(DOC_B, 60),
    ]) {
      expect(await code(op())).toBe("not_found");
    }
    expect(w.store.documents.get(DOC_B)!.starred).toBe(false);
  });
  it("cannot filter by, move into, or upload into another workspace's folder", async () => {
    const a = w.as(WS_A, "owner");
    expect(await code(a.listDocuments({ folderId: FOLDER_B }))).toBe("not_found");
    expect(await code(a.updateDocument(DOC_INVOICE, { folderId: FOLDER_B }))).toBe("not_found");
    expect(await code(a.initiateUpload(init({ folderId: FOLDER_B })))).toBe("not_found");
    expect(await code(a.renameFolder(FOLDER_B, { name: "pwn" }))).toBe("not_found");
    expect(await code(a.deleteFolder(FOLDER_B))).toBe("not_found");
    expect(w.store.folders.get(FOLDER_B)!.name).toBe("Beta Private");
  });
  it("search does not leak across workspaces", async () => {
    expect((await w.as(WS_A, "owner").listDocuments({ search: "beta-secret" })).total).toBe(0);
    expect((await w.as(WS_A, "owner").listDocuments({ tag: "Confidential" })).total).toBe(0);
    expect((await w.as(WS_B, "owner").listDocuments({ search: "beta-secret" })).total).toBe(1);
  });
  it("storage usage is per workspace", async () => {
    expect((await w.as(WS_B, "owner").getUsage()).usedBytes).toBe(4000);
    expect((await w.as(WS_A, "owner").getUsage()).usedBytes).toBeGreaterThan(4000);
  });
  it("refuses to sign a key that belongs to a different workspace", async () => {
    const versions = w.store.versions.get(DOC_INVOICE)!;
    versions[0].storageKey = w.keyB; // corrupted metadata pointing at B's object
    expect(await code(w.as(WS_A, "owner").getFileLink(DOC_INVOICE, { versionNumber: versions[0].versionNumber }))).toBe("forbidden");
  });
});

describe("upload validation and flow", () => {
  it("rejects disallowed type, mismatched MIME, empty and oversized files", async () => {
    const a = w.as(WS_A, "editor");
    expect(await code(a.initiateUpload(init({ fileName: "run.exe", mimeType: "application/x-msdownload" })))).toBe("validation");
    expect(await code(a.initiateUpload(init({ mimeType: "image/png" })))).toBe("validation");
    expect(await code(a.initiateUpload(init({ size: 0 })))).toMatch(/^other/); // zod: positive()
    expect(await code(a.initiateUpload(init({ size: 51 * 1024 * 1024 })))).toBe("validation");
    expect(await code(a.initiateUpload({ nonsense: true }))).toMatch(/^other/);
  });
  it("creates nothing when validation fails", async () => {
    const before = w.store.documents.size;
    await w.as(WS_A, "editor").initiateUpload(init({ fileName: "x.exe" })).catch(() => undefined);
    expect(w.store.documents.size).toBe(before);
  });
  it("sanitises hostile file names and never uses them in storage keys", async () => {
    const doc = await uploadFile(w, w.as(WS_A, "editor"), { name: "../../etc/pass\u0000wd.pdf" });
    expect(doc.displayName).not.toMatch(/[\\/\u0000]/);
    expect(doc.storageKey.startsWith(`${WS_A}/${doc.id}/`)).toBe(true);
    expect(doc.storageKey).not.toContain("etc");
  });
  it("completes initiate → put → finalize and defaults the category from the folder", async () => {
    const doc = await uploadFile(w, w.as(WS_A, "editor"), { name: "march.pdf" }, { folderId: FOLDER_INVOICES });
    expect(doc).toMatchObject({ status: "ready", category: "invoice", folderId: FOLDER_INVOICES, currentVersion: 1, sizeBytes: PDF_BYTES.byteLength });
    expect(w.store.audit.some((e) => e.action === "document.uploaded")).toBe(true);
  });
  it("hides pending uploads from listings and downloads", async () => {
    const a = w.as(WS_A, "editor");
    const i = await a.initiateUpload(init());
    expect((await a.listDocuments({ pageSize: 100 })).items.some((d) => d.id === i.documentId)).toBe(false);
    expect(await code(a.getFileLink(i.documentId))).toBe("not_found");
  });
  it("fails finalize and cleans up when the object never arrived", async () => {
    const a = w.as(WS_A, "editor");
    const i = await a.initiateUpload(init());
    expect(await code(a.finalizeUpload(i.documentId, i.versionNumber))).toBe("storage_failed");
    expect(w.store.documents.has(i.documentId)).toBe(false);
  });
  it("fails finalize when the stored size differs from the declared size", async () => {
    const a = w.as(WS_A, "editor");
    const i = await a.initiateUpload(init({ size: 100 }));
    const v = await w.repo.getVersion(WS_A, i.documentId, 1);
    w.storage.put(v!.storageKey, PDF_BYTES, "application/pdf"); // 13 bytes, not 100
    expect(await code(a.finalizeUpload(i.documentId, 1))).toBe("validation");
    expect(w.store.blobs.has(v!.storageKey)).toBe(false);
  });
  it("fails finalize when content does not match the extension", async () => {
    const a = w.as(WS_A, "editor");
    const bytes = new TextEncoder().encode("MZ-not-a-pdf");
    const i = await a.initiateUpload(init({ size: bytes.byteLength }));
    const v = await w.repo.getVersion(WS_A, i.documentId, 1);
    w.storage.put(v!.storageKey, bytes, "application/pdf");
    expect(await code(a.finalizeUpload(i.documentId, 1))).toBe("validation");
    expect(w.store.documents.has(i.documentId)).toBe(false);
  });
  it("lets only the uploader (or an admin) finish or cancel an upload", async () => {
    const i = await w.as(WS_A, "editor", "someone-else").initiateUpload(init());
    const mine = w.as(WS_A, "editor");
    expect(await code(mine.finalizeUpload(i.documentId, 1))).toBe("forbidden");
    expect(await code(mine.abortUpload(i.documentId, 1))).toBe("forbidden");
    await expect(w.as(WS_A, "admin").abortUpload(i.documentId, 1)).resolves.toBeUndefined();
  });
  it("cancelling removes the pending record", async () => {
    const a = w.as(WS_A, "editor");
    const i = await a.initiateUpload(init());
    await a.abortUpload(i.documentId, 1);
    expect(w.store.documents.has(i.documentId)).toBe(false);
  });
  it("adds versions to an existing document and keeps history", async () => {
    const a = w.as(WS_A, "editor");
    const doc = await uploadFile(w, a, { name: "contract.pdf" });
    const v2 = await uploadFile(w, a, { name: "contract-final.pdf", bytes: new TextEncoder().encode("%PDF-v2 longer") }, { documentId: doc.id });
    expect(v2.currentVersion).toBe(2);
    expect(v2.displayName).toBe("contract.pdf");
    const detail = await a.getDocument(doc.id);
    expect(detail.versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    await expect(a.getFileLink(doc.id, { versionNumber: 1 })).resolves.toBeTruthy();
    expect(await code(a.initiateUpload(init({ fileName: "x.png", mimeType: "image/png", documentId: doc.id })))).toBe("validation");
  });
});

describe("storage usage and quota", () => {
  it("counts every stored version and reflects uploads and purges", async () => {
    const a = w.as(WS_A, "admin");
    const before = (await a.getUsage()).usedBytes;
    const doc = await uploadFile(w, a, { name: "u.pdf" });
    await uploadFile(w, a, { name: "u.pdf" }, { documentId: doc.id });
    expect((await a.getUsage()).usedBytes).toBe(before + 2 * PDF_BYTES.byteLength);
    await a.deleteDocument(doc.id);
    expect((await a.getUsage()).usedBytes).toBe(before + 2 * PDF_BYTES.byteLength); // trash still occupies storage
    await a.purgeDocument(doc.id);
    expect((await a.getUsage()).usedBytes).toBe(before);
  });
  it("blocks uploads that exceed the quota, counting pending reservations", async () => {
    const used = (await w.as(WS_A, "owner").getUsage()).usedBytes;
    w.store.workspaces.get(WS_A)!.storageQuotaBytes = used + 150;
    const a = w.as(WS_A, "editor");
    await a.initiateUpload(init());
    expect(await code(a.initiateUpload(init({ fileName: "b.pdf" })))).toBe("quota_exceeded");
  });
  it("reports document count and quota in bootstrap", async () => {
    const b = await w.as(WS_A, "viewer").bootstrap();
    expect(b.usage).toMatchObject({ documentCount: 18, quotaBytes: 100 * 1024 * 1024 });
    expect(b.limits.maxFileSizeBytes).toBeGreaterThan(0);
  });
});

describe("download authorization", () => {
  it("returns a short-lived link and audits attachment downloads only", async () => {
    const a = w.as(WS_A, "viewer");
    const link = await a.getFileLink(DOC_INVOICE, { disposition: "attachment" });
    expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(61_000);
    expect(w.store.audit.filter((e) => e.action === "document.downloaded")).toHaveLength(1);
    await a.getFileLink(DOC_INVOICE, { disposition: "inline" });
    expect(w.store.audit.filter((e) => e.action === "document.downloaded")).toHaveLength(1);
  });
  it("refuses trashed documents and unknown versions", async () => {
    const e = w.as(WS_A, "editor");
    expect(await code(e.getFileLink(DOC_INVOICE, { versionNumber: 99 }))).toBe("not_found");
    await e.deleteDocument(DOC_INVOICE);
    expect(await code(e.getFileLink(DOC_INVOICE))).toBe("not_found");
  });
  it("share links: random, hashed at rest, bounded lifetime", async () => {
    const e = w.as(WS_A, "editor");
    const { token, expiresAt } = await e.createShareLink(DOC_INVOICE, 60);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(w.store.shares[0].tokenHash).toBe(await sha256Hex(token));
    expect(JSON.stringify(w.store.shares)).not.toContain(token);
    expect(Date.parse(expiresAt)).toBe(NOW.getTime() + 60 * 60_000);
    expect(await code(e.createShareLink(DOC_INVOICE, 1))).toBe("validation");
    expect(await code(e.createShareLink(DOC_INVOICE, 60 * 24 * 30))).toBe("validation");
    expect((await e.createShareLink(DOC_INVOICE, 60)).token).not.toBe(token);
  });
});

describe("folders and filtering", () => {
  it("filters by folder and reports counts that match", async () => {
    const a = w.as(WS_A, "viewer");
    const boot = await a.bootstrap();
    const invoices = boot.folders.find((f) => f.name === "Invoices")!;
    const page = await a.listDocuments({ folderId: invoices.id });
    expect(page.total).toBe(invoices.documentCount);
    expect(page.items.every((d) => d.folderId === invoices.id)).toBe(true);
  });
  it("filters by category, file type and tag; combines filters", async () => {
    const a = w.as(WS_A, "viewer");
    expect((await a.listDocuments({ category: "tax" })).total).toBe(3);
    expect((await a.listDocuments({ fileType: "excel" })).total).toBe(2);
    expect((await a.listDocuments({ fileType: "image" })).total).toBe(3);
    expect((await a.listDocuments({ tag: "q4" })).total).toBe(3);
    expect((await a.listDocuments({ category: "invoice", fileType: "pdf" })).total).toBe(2);
  });
  it("recent and starred views", async () => {
    const a = w.as(WS_A, "viewer");
    const starred = await a.listDocuments({ view: "starred", pageSize: 100 });
    expect(starred.items.length).toBeGreaterThan(0);
    expect(starred.items.every((d) => d.starred)).toBe(true);
    const recent = await a.listDocuments({ view: "recent", pageSize: 100 });
    expect(recent.items.every((d) => Date.parse(d.createdAt) >= NOW.getTime() - 31 * 86_400_000)).toBe(true);
    expect(recent.total).toBeLessThan(18);
  });
  it("sorts and paginates deterministically", async () => {
    const a = w.as(WS_A, "viewer");
    const p1 = await a.listDocuments({ sort: "name-asc", pageSize: 5, page: 1 });
    const p2 = await a.listDocuments({ sort: "name-asc", pageSize: 5, page: 2 });
    expect(p1.items).toHaveLength(5);
    expect(p1.total).toBe(18);
    expect(new Set([...p1.items, ...p2.items].map((d) => d.id)).size).toBe(10);
    const big = await a.listDocuments({ sort: "size-desc", pageSize: 3 });
    expect(big.items[0].sizeBytes).toBeGreaterThanOrEqual(big.items[1].sizeBytes);
  });
  it("creates, renames and deletes custom folders; protects system folders", async () => {
    const e = w.as(WS_A, "editor");
    const f = await e.createFolder({ name: "  Clients  " });
    expect(f).toMatchObject({ name: "Clients", isSystem: false });
    expect(await code(e.createFolder({ name: "clients" }))).toBe("conflict");
    expect(await code(e.createFolder({ name: "bad/name" }))).toMatch(/^other/); // zod
    await e.renameFolder(f.id, { name: "VIP Clients" });
    expect(await code(e.renameFolder(FOLDER_INVOICES, { name: "X" }))).toBe("forbidden");
    expect(await code(e.deleteFolder(FOLDER_INVOICES))).toBe("forbidden");
    await e.updateDocument(DOC_INVOICE, { folderId: f.id });
    await e.deleteFolder(f.id);
    expect((await e.getDocument(DOC_INVOICE)).folderId).toBeNull(); // documents survive
  });
});

describe("search", () => {
  const names = async (q: string) =>
    (await w.as(WS_A, "viewer").listDocuments({ search: q, pageSize: 100 })).items.map((d) => d.displayName);
  it("matches filenames case-insensitively", async () => {
    expect(await names("NORTHWIND")).toEqual(["Invoice_INV-2041_Northwind.pdf"]);
  });
  it("matches tags, category labels, extensions and uploader names", async () => {
    expect(await names("reimbursable")).toEqual(["Receipt_Office_Supplies_Staples.jpg"]);
    expect((await names("tax document")).length).toBe(3);
    expect((await names("xlsx")).length).toBe(2);
    expect((await names("maya")).length).toBeGreaterThanOrEqual(3);
  });
  it("requires every word to match", async () => {
    expect(await names("invoice northwind")).toHaveLength(1);
    expect(await names("invoice zzzz")).toHaveLength(0);
  });
  it("does not search document contents", async () => {
    expect(await names("placeholder")).toHaveLength(0); // appears only inside sample PDF bytes
  });
});

describe("rename, move, star, tags", () => {
  it("renames and keeps the original extension", async () => {
    const e = w.as(WS_A, "editor");
    expect((await e.updateDocument(DOC_INVOICE, { displayName: "Northwind Q4" })).displayName).toBe("Northwind Q4.pdf");
    expect((await e.getDocument(DOC_INVOICE)).originalName).toBe("Invoice_INV-2041_Northwind.pdf");
    expect(await code(e.updateDocument(DOC_INVOICE, { displayName: "   " }))).toBe("validation");
    expect(w.store.audit.some((a) => a.action === "document.renamed")).toBe(true);
  });
  it("moves between folders and out of folders", async () => {
    const e = w.as(WS_A, "editor");
    expect((await e.updateDocument(DOC_INVOICE, { folderId: FOLDER_RECEIPTS })).folderId).toBe(FOLDER_RECEIPTS);
    expect((await e.updateDocument(DOC_INVOICE, { folderId: null })).folderId).toBeNull();
    expect(w.store.audit.filter((a) => a.action === "document.moved")).toHaveLength(2);
  });
  it("stars and unstars", async () => {
    const e = w.as(WS_A, "editor");
    const before = (await e.getDocument(DOC_INVOICE)).starred;
    expect((await e.updateDocument(DOC_INVOICE, { starred: !before })).starred).toBe(!before);
    expect((await e.updateDocument(DOC_INVOICE, { starred: before })).starred).toBe(before);
    expect(w.store.audit.map((a) => a.action)).toEqual(expect.arrayContaining(["document.starred", "document.unstarred"]));
  });
  it("adds, removes and dedupes tags", async () => {
    const e = w.as(WS_A, "editor");
    const doc = await e.updateDocument(DOC_INVOICE, { tags: ["Alpha", "alpha", " Beta  tag "] });
    expect(doc.tags).toEqual(["Alpha", "Beta tag"]);
    expect((await e.updateDocument(DOC_INVOICE, { tags: [] })).tags).toEqual([]);
    expect((await e.bootstrap()).tags).not.toContain("Alpha");
    expect(dedupeTags(["a", "A", "b"])).toEqual(["a", "b"]);
    expect(await code(e.updateDocument(DOC_INVOICE, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }))).toMatch(/^other/);
  });
  it("rejects attempts to set protected fields", async () => {
    const e = w.as(WS_A, "editor");
    await expect(e.updateDocument(DOC_INVOICE, { workspaceId: WS_B, sizeBytes: 1 })).rejects.toThrow();
    expect(w.store.documents.get(DOC_INVOICE)!.workspaceId).toBe(WS_A);
  });
});

describe("delete, restore, purge", () => {
  it("soft-deletes, lists in trash, restores", async () => {
    const e = w.as(WS_A, "editor");
    await e.deleteDocument(DOC_INVOICE);
    expect((await e.listDocuments({ pageSize: 100 })).items.some((d) => d.id === DOC_INVOICE)).toBe(false);
    expect((await e.listDocuments({ view: "trash" })).items.map((d) => d.id)).toEqual([DOC_INVOICE]);
    expect((await e.bootstrap()).trashCount).toBe(1);
    expect(await code(e.updateDocument(DOC_INVOICE, { starred: true }))).toBe("not_found");
    await e.restoreDocument(DOC_INVOICE);
    expect((await e.getDocument(DOC_INVOICE)).deletedAt).toBeNull();
  });
  it("purge removes metadata, versions and stored objects, and only from trash", async () => {
    const a = w.as(WS_A, "admin");
    const doc = await uploadFile(w, a, { name: "gone.pdf" });
    const key = doc.storageKey;
    expect(await code(a.purgeDocument(doc.id))).toBe("conflict");
    await a.deleteDocument(doc.id);
    await a.purgeDocument(doc.id);
    expect(w.store.documents.has(doc.id)).toBe(false);
    expect(w.store.versions.has(doc.id)).toBe(false);
    expect(w.store.blobs.has(key)).toBe(false);
    expect(await code(a.getDocument(doc.id))).toBe("not_found");
    expect(w.store.audit.some((e) => e.action === "document.purged")).toBe(true);
  });
  it("audit entries carry no file contents", async () => {
    const e = w.as(WS_A, "editor");
    await uploadFile(w, e, { name: "secret.pdf", bytes: new TextEncoder().encode("%PDF-TOP-SECRET-BODY") });
    expect(JSON.stringify(w.store.audit)).not.toContain("TOP-SECRET-BODY");
  });
});
