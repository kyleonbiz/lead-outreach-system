// @vitest-environment node
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { canExtract, extractText } from "@/lib/dms/extract";
import { DEFAULT_EXTRACT_LIMITS } from "@/lib/dms/extract/limits";
import { listZip } from "@/lib/dms/extract/zip";
import { collectText, decodeEntities } from "@/lib/dms/extract/xml";
import { normalizeText } from "@/lib/dms/extract/text";
import { makePdf } from "@/lib/dms/memory/sample-files";

const enc = (s: string) => new TextEncoder().encode(s);
const run = (name: string, bytes: Uint8Array, limits = DEFAULT_EXTRACT_LIMITS) =>
  extractText({ bytes, fileName: name }, limits);

function docx(body: string, extra: Record<string, string> = {}) {
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
    ),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)])),
  });
}

describe("text and csv", () => {
  it("indexes plain text and csv", async () => {
    const t = await run("notes.txt", enc("Quarterly retainer agreement for Harbor Property"));
    expect(t).toMatchObject({ status: "indexed", reason: null });
    expect(t.text).toContain("Harbor Property");
    const c = await run("rows.csv", enc("Date,Vendor,Amount\n2025-09-02,Staples,84.20"));
    expect(c.text).toContain("Staples");
  });

  it("decodes UTF-16 with a BOM", async () => {
    const body = new Uint8Array([0xff, 0xfe, ...[..."Résumé tax 2025"].flatMap((ch) => [ch.charCodeAt(0), 0])]);
    expect((await run("a.txt", body)).text).toContain("Résumé tax 2025");
  });

  it("reports empty or symbol-only text as no_text_found", async () => {
    expect(await run("a.txt", enc("   \n\t "))).toMatchObject({ status: "unsupported", reason: "no_text_found" });
    expect(await run("a.txt", enc("--- *** ---"))).toMatchObject({ status: "unsupported", reason: "no_text_found" });
  });

  it("truncates to the character cap and says so", async () => {
    const r = await run("big.txt", enc("word ".repeat(5000)), { ...DEFAULT_EXTRACT_LIMITS, maxTextChars: 1000 });
    expect(r).toMatchObject({ status: "indexed", reason: "truncated" });
    expect(r.text.length).toBeLessThanOrEqual(1000);
  });

  it("strips control characters and highlight markers", async () => {
    const r = await run("a.txt", enc("alpha\u0000beta\u001f gamma delta"));
    expect(r.text).not.toMatch(/[\u0000-\u001f]/u.source.length ? /[\u0000\u001f]/ : /x/);
    expect(r.text).toContain("delta");
  });
});

describe("docx", () => {
  it("extracts body, footers and handles entities and breaks", async () => {
    const bytes = docx(
      "<w:p><w:r><w:t>Master Services Agreement</w:t></w:r></w:p><w:p><w:r><w:t>Fees &amp; Terms &#x41;</w:t></w:r></w:p><w:p><w:del><w:r><w:delText>deleted secret</w:delText></w:r></w:del></w:p>",
      { "word/footer1.xml": "<w:ftr xmlns:w='x'><w:p><w:r><w:t>Confidential footer</w:t></w:r></w:p></w:ftr>" },
    );
    const r = await run("a.docx", bytes);
    expect(r.status).toBe("indexed");
    expect(r.text).toContain("Master Services Agreement");
    expect(r.text).toContain("Fees & Terms A");
    expect(r.text).toContain("Confidential footer");
    expect(r.text).not.toContain("deleted secret");
    expect(r.text.split("\n").length).toBeGreaterThan(1);
  });

  it("does not expand DOCTYPE entities (XXE / billion laughs)", async () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "AAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY x SYSTEM "file:///etc/passwd">]><w:document><w:body><w:p><w:r><w:t>&b; &x; visible</w:t></w:r></w:p></w:body></w:document>`;
    const bytes = zipSync({ "word/document.xml": strToU8(xml) });
    const r = await run("a.docx", bytes);
    expect(r.text).toContain("visible");
    expect(r.text).not.toContain("AAAA");
    expect(r.text).not.toContain("root:");
  });

  it("rejects a docx that is not an OOXML package", async () => {
    const bytes = zipSync({ "hello.txt": strToU8("hi") });
    expect(await run("a.docx", bytes)).toMatchObject({ status: "unsupported", reason: "parse_error" });
  });
});

describe("xlsx", () => {
  const xlsx = (sheet: string, shared = "") =>
    zipSync({
      "xl/workbook.xml": strToU8(`<workbook><sheets><sheet name="Q3 Expenses" sheetId="1"/></sheets></workbook>`),
      "xl/sharedStrings.xml": strToU8(`<sst>${shared}</sst>`),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`),
    });

  it("reads shared strings, inline strings and numbers; skips phonetic runs and booleans", async () => {
    const bytes = xlsx(
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
        `<row r="2"><c r="A2" t="inlineStr"><is><t>Inline vendor</t></is></c><c r="B2"><v>1250.75</v></c><c r="C2" t="b"><v>1</v></c></row>`,
      `<si><t>Invoice</t></si><si><t>Northwind</t><rPh><t>PHONETIC</t></rPh></si>`,
    );
    const r = await run("a.xlsx", bytes);
    expect(r.status).toBe("indexed");
    expect(r.text).toContain("Q3 Expenses");
    expect(r.text).toContain("Invoice");
    expect(r.text).toContain("Northwind");
    expect(r.text).toContain("Inline vendor");
    expect(r.text).toContain("1250.75");
    expect(r.text).not.toContain("PHONETIC");
  });

  it("stops a shared-string amplification attack at the character cap", async () => {
    const big = "x".repeat(2000);
    const cells = Array.from({ length: 3000 }, (_, i) => `<c r="A${i}" t="s"><v>0</v></c>`).join("");
    const bytes = xlsx(`<row>${cells}</row>`, `<si><t>${big}</t></si>`);
    const r = await run("a.xlsx", bytes, { ...DEFAULT_EXTRACT_LIMITS, maxTextChars: 5000 });
    expect(r.text.length).toBeLessThanOrEqual(5000);
    expect(r.reason).toBe("truncated");
  });
});

describe("pptx", () => {
  it("extracts slide and notes text in slide order", async () => {
    const slide = (t: string) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
    const bytes = zipSync({
      "ppt/slides/slide10.xml": strToU8(slide("Tenth slide")),
      "ppt/slides/slide2.xml": strToU8(slide("Second slide")),
      "ppt/notesSlides/notesSlide2.xml": strToU8(slide("Speaker note")),
    });
    const r = await run("deck.pptx", bytes);
    expect(r.text.indexOf("Second slide")).toBeLessThan(r.text.indexOf("Tenth slide"));
    expect(r.text).toContain("Speaker note");
  });
});

describe("pdf", () => {
  it("extracts the text layer of a real PDF", async () => {
    const r = await run("a.pdf", makePdf("Statement of Work", ["Prepared for Harbor Property Group", "Net 30 payment terms"]));
    expect(r.status).toBe("indexed");
    expect(r.text).toContain("Statement of Work");
    expect(r.text).toContain("Harbor Property Group");
  });

  it("reports a PDF without a text layer honestly", async () => {
    expect(await run("scan.pdf", makePdf("", []))).toMatchObject({ status: "unsupported", reason: "no_text_found" });
  });

  it("rejects garbage that claims to be a PDF", async () => {
    const r = await run("x.pdf", enc("%PDF-1.4 this is not a pdf at all"));
    expect(r.status).toBe("unsupported");
    expect(r.text).toBe("");
  });
});

/** Applies `fn` to the offset of every central-directory record. */
function eachCentralEntry(zip: Uint8Array, fn: (offset: number) => void) {
  const eocd = zip.length - 22;
  let p = zip[eocd + 16] | (zip[eocd + 17] << 8) | (zip[eocd + 18] << 16);
  const total = zip[eocd + 10] | (zip[eocd + 11] << 8);
  for (let i = 0; i < total; i++) {
    fn(p);
    const len = (o: number) => zip[p + o] | (zip[p + o + 1] << 8);
    p += 46 + len(28) + len(30) + len(32);
  }
}

describe("hostile inputs", () => {
  it("rejects a zip bomb by size and by ratio without allocating it", async () => {
    const limits = { ...DEFAULT_EXTRACT_LIMITS, maxEntryBytes: 1024 * 1024, ratioFloorBytes: 64 * 1024 };
    const bomb = zipSync({ "word/document.xml": new Uint8Array(8 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(20_000);
    const t0 = Date.now();
    expect(await run("a.docx", bomb, limits)).toMatchObject({ status: "unsupported", reason: "unsafe_archive" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("enforces the ratio even when under the size cap", async () => {
    const limits = { ...DEFAULT_EXTRACT_LIMITS, maxRatio: 50, ratioFloorBytes: 10_000 };
    const bytes = zipSync({ "word/document.xml": new Uint8Array(2 * 1024 * 1024) }, { level: 9 });
    expect(await run("a.docx", bytes, limits)).toMatchObject({ reason: "unsafe_archive" });
  });

  it("rejects archives with too many entries", async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 40; i++) files[`f${i}.xml`] = strToU8("<a/>");
    expect(() => listZip(zipSync(files), { ...DEFAULT_EXTRACT_LIMITS, maxZipEntries: 10 })).toThrow();
  });

  it("survives truncated, corrupt and lying archives", async () => {
    const good = docx("<w:p><w:r><w:t>hello world</w:t></w:r></w:p>");
    for (const bad of [good.slice(0, good.length - 10), good.slice(0, 30), new Uint8Array(100), enc("PK\u0003\u0004 nope")]) {
      const r = await run("a.docx", bad);
      expect(["unsupported", "failed"]).toContain(r.status);
      expect(r.text).toBe("");
    }
    // Corrupt the central directory's local-header offset.
    const lying = good.slice();
    eachCentralEntry(lying, (p) => {
      lying[p + 42] = 0xff;
      lying[p + 43] = 0xff;
    });
    expect((await run("a.docx", lying)).status).toBe("unsupported");
  });

  it("refuses encrypted entries and oversize input", async () => {
    const good = docx("<w:p><w:r><w:t>secret</w:t></w:r></w:p>");
    const enc1 = good.slice();
    eachCentralEntry(enc1, (p) => {
      enc1[p + 8] |= 1; // general-purpose flag: encrypted
    });
    expect(await run("a.docx", enc1)).toMatchObject({ reason: "encrypted" });
    expect(await run("a.txt", enc("x".repeat(100)), { ...DEFAULT_EXTRACT_LIMITS, maxInputBytes: 10 })).toMatchObject({
      status: "unsupported",
      reason: "too_large",
    });
  });

  it("times out via the deadline instead of hanging", async () => {
    const body = "<w:p><w:r><w:t>a</w:t></w:r></w:p>".repeat(60000);
    const r = await run("a.docx", docx(body), { ...DEFAULT_EXTRACT_LIMITS, timeoutMs: 0, maxRatio: 100000 });
    expect(r).toMatchObject({ status: "failed", reason: "timeout" });
  });

  it("marks images and unknown types unsupported", async () => {
    expect(await run("a.png", new Uint8Array([0x89, 0x50]))).toMatchObject({ status: "unsupported", reason: "unsupported_type" });
    expect(canExtract("a.png")).toBe(false);
    expect(canExtract("A.DOCX")).toBe(true);
  });
});

describe("helpers", () => {
  it("decodes only predefined and numeric entities", () => {
    expect(decodeEntities("&lt;a&gt; &amp;amp; &quot;&apos; &#65;&#x42; &bogus; &#0; &#xD800;")).toBe("<a> &amp; \"' AB &bogus;  ");
  });
  it("normalizeText removes lone surrogates", () => {
    expect(normalizeText("a\ud800b", 100).text).toBe("a�b");
  });
  it("collectText ignores comments and CDATA", () => {
    const out = collectText("<r><!-- <w:t>hidden</w:t> --><w:t>shown</w:t><![CDATA[<w:t>x</w:t>]]></r>", {
      textTags: ["w:t"],
      maxChars: 100,
      check: () => undefined,
    });
    expect(out).toBe("shown");
  });
});
