/** Generates small but genuine files for the demo's sample records. */

const enc = new TextEncoder();

function escapePdf(s: string) {
  return s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "?");
}

/** A minimal, valid single-page PDF with a title and a few lines of text. */
export function makePdf(title: string, lines: string[]): Uint8Array {
  const content = [
    "BT /F1 22 Tf 56 760 Td (" + escapePdf(title) + ") Tj ET",
    ...lines.map(
      (l, i) => `BT /F1 12 Tf 56 ${720 - i * 20} Td (${escapePdf(l)}) Tj ET`,
    ),
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return enc.encode(out);
}

export function makeCsv(rows: string[][]): Uint8Array {
  return enc.encode(
    rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n"),
  );
}

/** Browser-only: draws a pastel placeholder image. Returns null where no canvas exists. */
export async function makeImage(
  label: string,
  mimeType: "image/png" | "image/jpeg",
): Promise<Uint8Array | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 420;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createLinearGradient(0, 0, 640, 420);
  g.addColorStop(0, "#c7d2fe");
  g.addColorStop(1, "#ddd6fe");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 640, 420);
  ctx.fillStyle = "#4338ca";
  ctx.font = "600 28px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(label, 320, 200);
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillStyle = "#6d28d9";
  ctx.fillText("Aurum Ventura sample image", 320, 236);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, mimeType));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}
