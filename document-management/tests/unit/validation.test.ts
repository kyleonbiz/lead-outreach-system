import { describe, expect, it } from "vitest";
import { loadUploadLimits, defaultUploadLimits } from "@/lib/dms/config";
import {
  buildStorageKey, fileTypeGroupOf, formatBytes, getExtension, magicBytesMatch, normalizeRename,
  sanitizeFilename, validateUploadCandidate, workspaceOfKey, documentQuerySchema, updateDocumentSchema,
} from "@/lib/dms/validation";

const limits = defaultUploadLimits();
const pdf = (over: Partial<{ name: string; size: number; type: string }> = {}) => ({
  name: "a.pdf", size: 100, type: "application/pdf", ...over,
});

describe("sanitizeFilename", () => {
  it("strips path separators and traversal", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(sanitizeFilename("..\\..\\win.ini")).not.toMatch(/[\\/]/);
    expect(sanitizeFilename("a/b\\c.pdf")).toBe("a_b_c.pdf");
  });
  it("removes control characters, bidi overrides and leading dots", () => {
    expect(sanitizeFilename("in\u0000voice‮.pdf")).toBe("invoice.pdf");
    expect(sanitizeFilename(".htaccess")).toBe("htaccess");
    expect(sanitizeFilename("   ")).toBe("");
  });
  it("caps length but keeps the extension", () => {
    const out = sanitizeFilename("x".repeat(400) + ".pdf");
    expect(out.length).toBeLessThanOrEqual(150);
    expect(out.endsWith(".pdf")).toBe(true);
  });
});

describe("validateUploadCandidate", () => {
  it("accepts every configured default type", () => {
    for (const [name, type] of [
      ["a.pdf", "application/pdf"], ["a.csv", "text/csv"], ["a.jpg", "image/jpeg"], ["a.png", "image/png"],
      ["a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ]) expect(validateUploadCandidate({ name, size: 10, type }, limits).ok).toBe(true);
  });
  it("rejects disallowed extensions", () => {
    const r = validateUploadCandidate(pdf({ name: "evil.exe", type: "application/x-msdownload" }), limits);
    expect(r).toMatchObject({ ok: false });
  });
  it("rejects a MIME type that does not match the extension", () => {
    expect(validateUploadCandidate(pdf({ type: "image/png" }), limits)).toMatchObject({ ok: false });
  });
  it("rejects double extensions that end in a disallowed type", () => {
    expect(validateUploadCandidate(pdf({ name: "invoice.pdf.exe" }), limits)).toMatchObject({ ok: false });
  });
  it("rejects empty and oversized files", () => {
    expect(validateUploadCandidate(pdf({ size: 0 }), limits)).toMatchObject({ ok: false });
    expect(validateUploadCandidate(pdf({ size: limits.maxFileSizeBytes + 1 }), limits)).toMatchObject({ ok: false });
    expect(validateUploadCandidate(pdf({ size: limits.maxFileSizeBytes }), limits).ok).toBe(true);
  });
  it("falls back to the canonical type when the browser reports none", () => {
    expect(validateUploadCandidate(pdf({ type: "" }), limits)).toMatchObject({ ok: true, mimeType: "application/pdf" });
  });
  it("rejects names without an extension", () => {
    expect(validateUploadCandidate(pdf({ name: "README" }), limits)).toMatchObject({ ok: false });
  });
});

describe("limits configuration", () => {
  it("honours env overrides", () => {
    const l = loadUploadLimits({ DMS_MAX_FILE_SIZE_MB: "5", DMS_ALLOWED_EXTENSIONS: "pdf,png", DMS_EXTRA_FILE_TYPES: "rtf=application/rtf" });
    expect(l.maxFileSizeBytes).toBe(5 * 1024 * 1024);
    expect(l.allowedTypes.map((t) => t.extension).sort()).toEqual(["pdf", "png", "rtf"]);
  });
  it("ignores malformed extra types", () => {
    const l = loadUploadLimits({ DMS_EXTRA_FILE_TYPES: "../x=text/plain;bad" });
    expect(l.allowedTypes.some((t) => t.extension.includes("."))).toBe(false);
  });
});

describe("storage keys", () => {
  const ws = "00000000-0000-4000-8000-000000000001";
  const doc = "11111111-1111-4111-8111-111111111111";
  it("builds workspace-prefixed keys and parses them back", () => {
    const key = buildStorageKey({ workspaceId: ws, documentId: doc, versionNumber: 2, extension: "pdf", nonce: "abc123" });
    expect(key).toBe(`${ws}/${doc}/v2-abc123.pdf`);
    expect(workspaceOfKey(key)).toBe(ws);
  });
  it("refuses unsafe parts", () => {
    expect(() => buildStorageKey({ workspaceId: ws, documentId: "../x", versionNumber: 1, extension: "pdf", nonce: "a" })).toThrow();
    expect(() => buildStorageKey({ workspaceId: ws, documentId: doc, versionNumber: 1, extension: "pdf", nonce: "a/b" })).toThrow();
  });
  it("never trusts a malformed key's workspace", () => {
    expect(workspaceOfKey("../other/file.pdf")).toBeNull();
    expect(workspaceOfKey(`${ws}/../x.pdf`)).toBeNull();
  });
});

describe("helpers", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });
  it("detects magic bytes", () => {
    expect(magicBytesMatch("pdf", new TextEncoder().encode("%PDF-1.7"))).toBe(true);
    expect(magicBytesMatch("pdf", new TextEncoder().encode("MZ\x90"))).toBe(false);
    expect(magicBytesMatch("csv", new Uint8Array([1, 2]))).toBe(true);
  });
  it("renames while preserving the extension", () => {
    expect(normalizeRename("Q4 invoice", "a.pdf")).toBe("Q4 invoice.pdf");
    expect(normalizeRename("x.pdf", "a.pdf")).toBe("x.pdf");
    expect(normalizeRename("///", "a.pdf")).toBe("___.pdf");
    expect(normalizeRename("   ", "a.pdf")).toBe("");
    expect(getExtension("a.tar.GZ")).toBe("gz");
  });
  it("groups file types", () => {
    expect(fileTypeGroupOf("application/pdf", "a.pdf")).toBe("pdf");
    expect(fileTypeGroupOf("image/png", "a.png")).toBe("image");
    expect(fileTypeGroupOf("text/plain", "a.txt")).toBe("other");
  });
  it("validates query and update schemas", () => {
    expect(documentQuerySchema.parse({}).pageSize).toBe(24);
    expect(() => documentQuerySchema.parse({ folderId: "nope" })).toThrow();
    expect(() => documentQuerySchema.parse({ pageSize: 9999 })).toThrow();
    expect(() => updateDocumentSchema.parse({})).toThrow();
    expect(() => updateDocumentSchema.parse({ workspaceId: "x" })).toThrow();
  });
});
