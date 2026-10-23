"use client";

import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DmsApi } from "@/lib/dms/client/api";
import { toDmsError } from "@/lib/dms/errors";
import type { DocumentRecord } from "@/lib/dms/types";
import { cn } from "@/lib/utils";
import { fileKindOf } from "./file-kind";

type State =
  | { status: "loading" }
  | { status: "ready"; url: string; text?: string }
  | { status: "error"; message: string };

const MAX_TEXT_BYTES = 200_000;

export function DocumentPreview({
  api,
  doc,
  onDownload,
}: {
  api: DmsApi;
  doc: DocumentRecord;
  onDownload: () => void;
}) {
  const kind = fileKindOf(doc.mimeType, doc.originalName);
  const previewable = kind.previewable;
  const [state, setState] = useState<State>({ status: "loading" });
  const version = doc.currentVersion;

  useEffect(() => {
    if (!previewable) return;
    let cancelled = false;
    let blobUrl: string | null = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ status: "loading" });
    (async () => {
      try {
        const link = await api.getFileLink(doc.id, { versionNumber: version, disposition: "inline" });
        if (link.url.startsWith("blob:")) blobUrl = link.url;
        let text: string | undefined;
        if (previewable === "text") {
          const res = await fetch(link.url);
          if (!res.ok) throw new Error("Could not load the preview.");
          text = (await res.text()).slice(0, MAX_TEXT_BYTES);
        }
        if (!cancelled) setState({ status: "ready", url: link.url, text });
      } catch (e) {
        if (!cancelled) setState({ status: "error", message: toDmsError(e).message });
      }
    })();
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [api, doc.id, version, previewable]);

  const frame = "flex min-h-[260px] w-full flex-1 items-center justify-center overflow-hidden rounded-xl border bg-muted/40";

  if (!previewable) {
    return (
      <div className={cn(frame, "flex-col gap-3 p-8 text-center")} data-testid="preview-unsupported">
        <span className={cn("flex size-20 items-center justify-center rounded-2xl", kind.tile)}>
          <kind.Icon className="size-10" aria-hidden />
        </span>
        <div>
          <p className="text-sm font-semibold">Preview not available for {kind.label} files</p>
          <p className="mt-1 text-xs text-muted-foreground">Download the file to view it on your device.</p>
        </div>
        <Button variant="outline" onClick={onDownload}>
          <Download /> Download to view
        </Button>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div className={frame} role="status" aria-label="Loading preview">
        <Loader2 className="size-6 animate-spin text-violet-500" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className={cn(frame, "flex-col gap-3 p-8 text-center")} role="alert">
        <p className="text-sm font-medium">Preview unavailable</p>
        <p className="max-w-xs text-xs text-muted-foreground">{state.message}</p>
        <Button variant="outline" onClick={onDownload}>
          <Download /> Download instead
        </Button>
      </div>
    );
  }

  if (previewable === "image") {
    return (
      <div className={frame}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={state.url} alt={`Preview of ${doc.displayName}`} className="max-h-[60vh] max-w-full object-contain" />
      </div>
    );
  }
  if (previewable === "pdf") {
    return (
      <div className={cn(frame, "min-h-[360px]")}>
        <iframe
          src={state.url}
          title={`Preview of ${doc.displayName}`}
          className="h-full min-h-[360px] w-full bg-white"
        />
      </div>
    );
  }
  return (
    <div className={cn(frame, "items-start overflow-auto")}>
      {doc.originalName.toLowerCase().endsWith(".csv") ? (
        <CsvTable text={state.text ?? ""} />
      ) : (
        <pre className="w-full whitespace-pre-wrap break-words p-4 font-mono text-xs">{state.text}</pre>
      )}
    </div>
  );
}

function CsvTable({ text }: { text: string }) {
  const rows = parseCsv(text).slice(0, 50);
  if (rows.length === 0) return <p className="p-4 text-sm text-muted-foreground">This file is empty.</p>;
  const [head, ...body] = rows;
  return (
    <table className="w-full border-collapse text-left text-xs">
      <thead className="sticky top-0 bg-muted">
        <tr>
          {head.map((h, i) => (
            <th key={i} className="whitespace-nowrap border-b px-3 py-2 font-semibold">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((r, i) => (
          <tr key={i} className="odd:bg-card even:bg-transparent">
            {r.map((c, j) => (
              <td key={j} className="whitespace-nowrap border-b px-3 py-1.5">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}
