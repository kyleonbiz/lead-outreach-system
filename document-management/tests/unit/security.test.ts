import { afterEach, describe, expect, it, vi } from "vitest";
import { safeNext } from "@/lib/safe-redirect";
import { BLOCKED_EXTENSIONS, isBlockedType, loadUploadLimits } from "@/lib/dms/config";
import { sameOrigin } from "@/lib/dms/server/respond";
import { mapDbError } from "@/lib/dms/supabase/mappers";
import { SupabaseStorage } from "@/lib/dms/supabase/storage";
import { sanitizeFilename } from "@/lib/dms/validation";

afterEach(() => vi.unstubAllEnvs());

describe("safeNext (open redirect)", () => {
  // The URL parser strips tab/CR/LF, so "/\t/evil.com" resolves to "//evil.com".
  const hostile = [
    "/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "/\t\t/evil.com", "/ /evil.com",
    "//evil.com", "/\\evil.com", "/\\/evil.com", "https://evil.com", "javascript:alert(1)",
    "/\u0000/evil.com", "/ /evil.com", "\t/app", "app",
  ];
  it.each(hostile)("rejects %j", (v) => {
    expect(safeNext(v)).toBe("/app");
    expect(new URL(safeNext(v), "https://app.example").origin).toBe("https://app.example");
  });
  it("keeps ordinary in-app paths, queries and fragments", () => {
    expect(safeNext("/app")).toBe("/app");
    expect(safeNext("/app?folder=1&x=%2F#top")).toBe("/app?folder=1&x=%2F#top");
  });
  it("never produces a destination off our origin for a fuzzed set", () => {
    const chars = ["/", "\\", "\t", "\n", "%", "0", "9", "a", ".", ":", "@", " "];
    for (let i = 0; i < 3000; i++) {
      let v = "/";
      for (let n = 0; n < 6; n++) v += chars[(i * 7 + n * 13 + (i >> n)) % chars.length];
      expect(new URL(safeNext(v), "https://app.example").origin).toBe("https://app.example");
    }
  });
});

describe("cross-origin protection", () => {
  const req = (method: string, headers: Record<string, string>) =>
    new Request("https://app.example/api/dms/x", { method, headers: { host: "app.example", ...headers } });
  it("allows same-origin mutations and header-less non-browser clients", () => {
    expect(sameOrigin(req("POST", { origin: "https://app.example" }))).toBe(true);
    expect(sameOrigin(req("DELETE", {}))).toBe(true);
  });
  it("blocks other origins, opaque origins and Sec-Fetch-Site cross-site", () => {
    expect(sameOrigin(req("POST", { origin: "https://evil.example" }))).toBe(false);
    expect(sameOrigin(req("POST", { origin: "null" }))).toBe(false);
    expect(sameOrigin(req("POST", { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOrigin(req("POST", { origin: "https://app.example.evil.com" }))).toBe(false);
  });
  it("does not gate safe methods", () => {
    expect(sameOrigin(req("GET", { origin: "https://evil.example" }))).toBe(true);
  });
});

describe("upload type configuration", () => {
  it("never lets operators enable script-capable types", () => {
    vi.stubEnv(
      "DMS_EXTRA_FILE_TYPES",
      "html=text/html;svg=image/svg+xml;xml=application/xml;js=text/javascript;htm=application/xhtml+xml;exe=application/x-msdownload;rtf=application/rtf;ODT=application/vnd.oasis.opendocument.text",
    );
    const exts = loadUploadLimits().allowedTypes.map((t) => t.extension);
    for (const bad of ["html", "svg", "xml", "js", "htm", "exe"]) expect(exts).not.toContain(bad);
    expect(exts).toContain("rtf");
    expect(exts).toContain("odt");
  });
  it("blocks by MIME type even under an innocent extension", () => {
    expect(isBlockedType("doc2", ["text/html; charset=utf-8"])).toBe(true);
    expect(isBlockedType("pic", ["image/svg+xml"])).toBe(true);
    expect(isBlockedType("pdf", ["application/pdf"])).toBe(false);
    expect(BLOCKED_EXTENSIONS.has("pdf")).toBe(false);
  });
  it("default allow-list contains no blocked type", () => {
    for (const t of loadUploadLimits({}).allowedTypes) expect(isBlockedType(t.extension, t.mimeTypes)).toBe(false);
  });
});

describe("download filename hardening", () => {
  it("re-sanitises names before they reach Content-Disposition", async () => {
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: "https://s/x" }, error: null });
    const client = { storage: { from: () => ({ createSignedUrl }) } } as never;
    await new SupabaseStorage(client).createDownloadUrl("k", {
      fileName: 'evil"\r\nSet-Cookie: a=b/../x.pdf',
      disposition: "attachment",
      ttlSeconds: 60,
    });
    const opts = createSignedUrl.mock.calls[0][2] as { download: string };
    expect(opts.download).not.toMatch(/["\r\n/\\]/);
    expect(opts.download).toBe(sanitizeFilename('evil"\r\nSet-Cookie: a=b/../x.pdf'));
  });
});

describe("database error mapping for the hardening migration", () => {
  it("maps size/object mismatches and the workspace cap to safe client errors", () => {
    expect(mapDbError({ code: "22023", message: "invalid_upload: size_mismatch" }).code).toBe("validation");
    expect(mapDbError({ code: "22023", message: "invalid_upload: object_missing" }).code).toBe("validation");
    expect(mapDbError({ code: "P0001", message: "workspace_limit: x" }).code).toBe("quota_exceeded");
  });
});
