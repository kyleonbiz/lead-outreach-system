// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Snippet, contentStatusLabel } from "@/components/dms/snippet";
import { HIGHLIGHT_END as E, HIGHLIGHT_START as S, makeSnippet, parseContentQuery } from "@/lib/dms/query";
import { SupabaseRepository } from "@/lib/dms/supabase/repository";
import { SupabaseStorage } from "@/lib/dms/supabase/storage";
import { documentFromRow } from "@/lib/dms/supabase/mappers";
import { reindexBatch } from "@/lib/dms/server/reindex";
import { WS_A, makeWorld, uploadFile, type World } from "../support/world";
import { fakeStorageClient, fakeSupabase } from "../support/fake-supabase";

const enc = (s: string) => new TextEncoder().encode(s);
const TXT = "text/plain";

let w: World;
beforeEach(() => {
  w = makeWorld();
});

async function uploadText(name: string, body: string, svc = w.as(WS_A, "editor")) {
  return uploadFile(w, svc, { name, bytes: enc(body), type: TXT });
}
const search = async (q: string, sort: "newest" | "relevance" = "newest", role: "viewer" | "editor" = "editor") =>
  (await w.as(WS_A, role).listDocuments({ search: q, sort })).items;

describe("query parsing (websearch subset)", () => {
  it("ANDs words, keeps quoted phrases, splits on OR and handles exclusions", () => {
    expect(parseContentQuery("rent tenant")).toEqual([
      [{ words: ["rent"], negated: false }, { words: ["tenant"], negated: false }],
    ]);
    expect(parseContentQuery('"ninety days" -crab')).toEqual([
      [{ words: ["ninety", "days"], negated: false }, { words: ["crab"], negated: true }],
    ]);
    expect(parseContentQuery("a or b")).toHaveLength(2);
  });
  it("ignores operator-only input", () => {
    expect(parseContentQuery('- "" or')).toEqual([]);
  });
});

describe("snippets", () => {
  it("wraps matches in the private-use delimiters and trims long text", () => {
    const text = "x ".repeat(100) + "the tenant pays rent " + "y ".repeat(100);
    const s = makeSnippet(text, parseContentQuery("rent"))!;
    expect(s).toContain(`${S}rent${E}`);
    expect(s.startsWith("… ")).toBe(true);
    expect(s.endsWith(" …")).toBe(true);
    expect(s.length).toBeLessThan(260);
  });
  it("renders as inert text: markup in a document stays text", () => {
    render(<Snippet text={`before ${S}<img src=x onerror=alert(1)>${E} after`} />);
    const el = screen.getByTestId("snippet");
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("mark")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("status labels never over-claim", () => {
  it("only 'indexed' is described as searchable", () => {
    expect(contentStatusLabel("indexed", null)).toBe("Searchable");
    expect(contentStatusLabel("indexed", "truncated")).toMatch(/first part/);
    expect(contentStatusLabel("pending", null)).toMatch(/name only/);
    expect(contentStatusLabel("unsupported", "no_text_found")).toMatch(/scanned/);
    expect(contentStatusLabel("failed", "timeout")).toMatch(/Not indexed/);
  });
});

describe("indexing through the service (memory adapters)", () => {
  it("a fresh upload is pending and matches by name only until indexed", async () => {
    const doc = await uploadText("lease.txt", "The tenant pays quarterly rent in advance.");
    expect(doc.contentStatus).toBe("pending");
    expect((await search("quarterly")).length).toBe(0);
    expect((await search("lease")).map((d) => d.id)).toContain(doc.id);

    expect(await w.as(WS_A, "editor").indexDocument(doc.id, doc.currentVersion)).toBe("indexed");
    const hits = await search("quarterly");
    expect(hits.map((d) => d.id)).toEqual([doc.id]);
    expect(hits[0].contentMatch).toBe(true);
    expect(hits[0].snippet).toContain(`${S}quarterly${E}`);
    expect(hits[0].contentStatus).toBe("indexed");
  });

  it("supports phrases, OR and exclusion", async () => {
    const a = await uploadText("a.txt", "termination requires ninety days notice");
    await w.as(WS_A, "editor").indexDocument(a.id, 1);
    expect((await search('"ninety days"')).length).toBe(1);
    expect((await search('"days ninety"')).length).toBe(0);
    expect((await search("zzzz or termination")).length).toBe(1);
    expect((await search("termination -ninety")).length).toBe(0);
  });

  it("a pending document's text is never matched", async () => {
    const doc = await uploadText("p.txt", "secretzebra");
    w.store.contentText.set(doc.id, "secretzebra"); // even if text somehow existed
    expect((await search("secretzebra")).length).toBe(0);
  });

  it("types without text are recorded as unsupported, without reading the file", async () => {
    const read = vi.spyOn(w.storage, "read");
    const png = await uploadFile(w, w.as(WS_A, "editor"), { name: "scan.png", type: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
    expect(await w.as(WS_A, "editor").indexDocument(png.id, 1)).toBe("unsupported");
    expect(read).not.toHaveBeenCalled();
    const d = await w.repo.getDocument(WS_A, png.id);
    expect(d).toMatchObject({ contentStatus: "unsupported", contentReason: "unsupported_type" });
  });

  it("a file with no letters or digits is unsupported (no_text_found)", async () => {
    const doc = await uploadText("blank.txt", "--- !!! ...");
    expect(await w.as(WS_A, "editor").indexDocument(doc.id, 1)).toBe("unsupported");
    expect((await w.repo.getDocument(WS_A, doc.id))?.contentReason).toBe("no_text_found");
  });

  it("an unreadable object becomes failed/read_error and never throws", async () => {
    const doc = await uploadText("gone.txt", "hello world");
    w.store.blobs.clear();
    expect(await w.as(WS_A, "editor").indexDocument(doc.id, 1)).toBe("failed");
    expect((await w.repo.getDocument(WS_A, doc.id))?.contentReason).toBe("read_error");
  });

  it("a storage failure is swallowed and leaves the document pending", async () => {
    const doc = await uploadText("boom.txt", "hello world");
    vi.spyOn(w.storage, "read").mockRejectedValue(new Error("boom"));
    expect(await w.as(WS_A, "editor").indexDocument(doc.id, 1)).toBe("failed");
  });

  it("oversized files are not read into memory", async () => {
    const doc = await uploadText("big.txt", "hello world");
    vi.spyOn(w.storage, "read").mockResolvedValue({ tooLarge: true });
    expect(await w.as(WS_A, "editor").indexDocument(doc.id, 1)).toBe("unsupported");
    expect((await w.repo.getDocument(WS_A, doc.id))?.contentReason).toBe("too_large");
  });

  it("a new version clears the old text and ignores a late write for the old version", async () => {
    const svc = w.as(WS_A, "editor");
    const v1 = await uploadText("notes.txt", "alpha content");
    await svc.indexDocument(v1.id, 1);
    expect((await search("alpha")).length).toBe(1);

    const v2 = await uploadFile(w, svc, { name: "notes.txt", bytes: enc("beta content"), type: TXT }, { documentId: v1.id });
    expect(v2.contentStatus).toBe("pending");
    expect((await search("alpha")).length).toBe(0);
    expect(await svc.indexDocument(v1.id, 1)).toBeNull(); // stale version
    expect(await svc.indexDocument(v1.id, 2)).toBe("indexed");
    expect((await search("beta")).length).toBe(1);
    expect((await search("alpha")).length).toBe(0);
  });

  it("purging a document drops its text", async () => {
    const svc = w.as(WS_A, "admin");
    const doc = await uploadText("gone.txt", "ephemeral words", svc);
    await svc.indexDocument(doc.id, 1);
    await svc.deleteDocument(doc.id);
    await svc.purgeDocument(doc.id);
    expect(w.store.contentText.has(doc.id)).toBe(false);
  });

  it("viewers cannot trigger indexing; indexDocument never throws", async () => {
    const doc = await uploadText("v.txt", "hello");
    expect(await w.as(WS_A, "viewer").indexDocument(doc.id, 1)).toBeNull();
    expect((await w.repo.getDocument(WS_A, doc.id))?.contentStatus).toBe("pending");
    await expect(w.as(WS_A, "viewer").indexPending()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("viewers can search content", async () => {
    const doc = await uploadText("v.txt", "visible words");
    await w.as(WS_A, "editor").indexDocument(doc.id, 1);
    expect((await search("visible", "newest", "viewer")).length).toBe(1);
  });

  it("indexPending processes the backlog, skipping documents that are not ready", async () => {
    await uploadText("one.txt", "first words");
    await uploadText("two.txt", "second words");
    const counts = await w.as(WS_A, "editor").indexPending({ limit: 50 });
    expect(counts.indexed).toBeGreaterThanOrEqual(2); // plus the generated sample PDFs/CSVs
    expect(counts.indexed + counts.unsupported + counts.failed).toBe(counts.processed);
    // the seeded sample PDFs/CSVs are generated on demand, so they index too
    expect((await search("second")).length).toBe(1);
    expect((await w.as(WS_A, "editor").indexPending({ limit: 50 })).processed).toBe(0);
  });

  it("failed documents are retried only when asked", async () => {
    const doc = await uploadText("f.txt", "retry me");
    const blobs = new Map(w.store.blobs);
    w.store.blobs.clear();
    const svc = w.as(WS_A, "editor");
    await svc.indexPending({ limit: 50 });
    expect((await w.repo.getDocument(WS_A, doc.id))?.contentStatus).toBe("failed");
    w.store.blobs = blobs;
    expect((await svc.indexPending({ limit: 50 })).processed).toBe(0);
    expect((await svc.indexPending({ limit: 50, includeFailed: true })).indexed).toBe(1);
  });

  it("relevance puts filename matches before content-only matches", async () => {
    const svc = w.as(WS_A, "editor");
    const byContent = await uploadText("misc.txt", "budget budget budget");
    const byName = await uploadText("budget-plan.txt", "nothing relevant here at all");
    await svc.indexDocument(byContent.id, 1);
    await svc.indexDocument(byName.id, 1);
    const ids = (await search("budget", "relevance")).map((d) => d.id);
    expect(ids.slice(0, 2)).toEqual([byName.id, byContent.id]);
  });

  it("other workspaces never see or match this workspace's text", async () => {
    const doc = await uploadText("ws.txt", "confidential zebra");
    await w.as(WS_A, "editor").indexDocument(doc.id, 1);
    const other = await w.as("00000000-0000-4000-8000-000000000002", "editor", "00000000-0000-4000-8000-0000000000b2").listDocuments({ search: "zebra" });
    expect(other.total).toBe(0);
  });
});

describe("Supabase adapters for content", () => {
  const WS = "11111111-1111-4111-8111-111111111111";
  const DOC = "22222222-2222-4222-8222-222222222222";

  it("maps content columns and search extras from rows", () => {
    const base = {
      id: DOC, workspace_id: WS, original_name: "a.pdf", display_name: "a.pdf", storage_key: "k", mime_type: "application/pdf",
      size_bytes: 1, category: "other", created_at: "x", updated_at: "x", status: "ready", current_version: 1,
    };
    expect(documentFromRow({ ...base })).toMatchObject({ contentStatus: "pending", contentReason: null, contentIndexedAt: null });
    expect("snippet" in documentFromRow({ ...base })).toBe(false);
    const hit = documentFromRow({ ...base, content_status: "indexed", content_reason: "truncated", content_indexed_at: "t", content_match: true, snippet: `${S}a${E}` });
    expect(hit).toMatchObject({ contentStatus: "indexed", contentReason: "truncated", contentMatch: true, snippet: `${S}a${E}` });
  });

  it("calls the content RPCs with the expected arguments", async () => {
    const { client, rpcCalls } = fakeSupabase({
      rpc: { dms_set_document_content: { data: true }, dms_list_unindexed: { data: [{ document_id: DOC, version_number: "3" }] } },
    });
    const repo = new SupabaseRepository(client);
    expect(await repo.setDocumentContent({ workspaceId: WS, documentId: DOC, versionNumber: 3, status: "indexed", reason: null, text: "hi" })).toBe(true);
    expect(rpcCalls("dms_set_document_content")[0].args).toEqual({
      p_workspace: WS, p_document: DOC, p_version: 3, p_status: "indexed", p_reason: null, p_text: "hi",
    });
    expect(await repo.listDocumentsNeedingIndex(WS, { limit: 5, includeFailed: true })).toEqual([{ id: DOC, currentVersion: 3 }]);
    expect(rpcCalls("dms_list_unindexed")[0].args).toEqual({ p_workspace: WS, p_limit: 5, p_include_failed: true });
  });

  it("a false answer from the database means nothing was stored", async () => {
    const { client } = fakeSupabase({ rpc: { dms_set_document_content: { data: false } } });
    expect(await new SupabaseRepository(client).setDocumentContent({ workspaceId: WS, documentId: DOC, versionNumber: 1, status: "failed", reason: "x", text: null })).toBe(false);
  });

  describe("SupabaseStorage.read", () => {
    const streamOf = (chunks: Uint8Array[], headers: Record<string, string> = {}) =>
      new Response(new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } }), { headers });

    it("returns the bytes of a small object", async () => {
      const { client } = fakeStorageClient();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(streamOf([enc("ab"), enc("cd")]));
      const r = await new SupabaseStorage(client).read("k", 100);
      expect(r && "bytes" in r && new TextDecoder().decode(r.bytes)).toBe("abcd");
    });
    it("refuses by Content-Length without reading the body", async () => {
      const { client } = fakeStorageClient();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(streamOf([enc("ab")], { "content-length": "5000" }));
      expect(await new SupabaseStorage(client).read("k", 100)).toEqual({ tooLarge: true });
    });
    it("stops reading when the body exceeds the limit despite a missing or wrong Content-Length", async () => {
      const { client } = fakeStorageClient();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(streamOf([new Uint8Array(60), new Uint8Array(60)], { "content-length": "10" }));
      expect(await new SupabaseStorage(client).read("k", 100)).toEqual({ tooLarge: true });
    });
    it("returns null when the object cannot be fetched", async () => {
      const { client } = fakeStorageClient();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 404 }));
      expect(await new SupabaseStorage(client).read("k", 100)).toBeNull();
      const failing = fakeStorageClient({ createSignedUrl: vi.fn(async () => ({ data: null, error: { message: "x" } })) });
      expect(await new SupabaseStorage(failing.client).read("k", 100)).toBeNull();
    });
  });
});

describe("reindexBatch (service role)", () => {
  const row = (n: number) => ({ workspace_id: "w", document_id: `d${n}`, version_number: n, storage_key: `k${n}`, file_name: `f${n}.txt` });

  it("computes and stores each document, counting outcomes", async () => {
    const stored: Record<string, unknown>[] = [];
    const { client } = fakeSupabase({
      rpc: {
        dms_service_list_unindexed: { data: [row(1), row(2), row(3)] },
        dms_service_set_document_content: (a) => {
          stored.push(a);
          return { data: a.p_document !== "d3" }; // d3's version changed meanwhile
        },
      },
    });
    const compute = vi.fn(async (_s: unknown, f: { storageKey: string }) =>
      f.storageKey === "k2"
        ? { status: "unsupported" as const, reason: "no_text_found", text: null }
        : { status: "indexed" as const, reason: null, text: "t" },
    );
    const res = await reindexBatch(client, { limit: 10, includeFailed: false, budgetMs: 1000 }, { compute, storage: {} as never });
    expect(res).toEqual({ found: 3, indexed: 1, unsupported: 1, failed: 0, skipped: 1, incomplete: false });
    expect(stored[0]).toMatchObject({ p_workspace: "w", p_document: "d1", p_version: 1, p_status: "indexed", p_text: "t" });
  });

  it("stops when the time budget is spent and says so", async () => {
    const { client } = fakeSupabase({
      rpc: { dms_service_list_unindexed: { data: [row(1), row(2)] }, dms_service_set_document_content: { data: true } },
    });
    let t = 0;
    const res = await reindexBatch(
      client,
      { limit: 10, includeFailed: false, budgetMs: 100 },
      { compute: async () => ({ status: "indexed", reason: null, text: "t" }), storage: {} as never, now: () => (t += 80) },
    );
    expect(res).toMatchObject({ found: 2, indexed: 1, incomplete: true });
  });

  it("throws a generic error when listing fails", async () => {
    const { client } = fakeSupabase({ rpc: { dms_service_list_unindexed: { error: { code: "XX", message: "secret" } } } });
    await expect(reindexBatch(client, { limit: 1, includeFailed: false, budgetMs: 1 }, { storage: {} as never })).rejects.toThrow("list_failed");
  });
});
