import { HIGHLIGHT_END, HIGHLIGHT_START } from "@/lib/dms/query";
import { REASON_LABELS } from "@/lib/dms/extract/errors";
import type { ContentStatus } from "@/lib/dms/types";

/**
 * Renders a search snippet. The text is plain; matches are wrapped in two private-use
 * characters that cannot occur in stored text. It is only ever placed in React text
 * nodes, never parsed as HTML.
 */
export function Snippet({ text, className }: { text: string; className?: string }) {
  const parts: { text: string; hit: boolean }[] = [];
  let hit = false;
  let buf = "";
  for (const ch of text) {
    if (ch === HIGHLIGHT_START || ch === HIGHLIGHT_END) {
      if (buf) parts.push({ text: buf, hit });
      buf = "";
      hit = ch === HIGHLIGHT_START;
    } else buf += ch;
  }
  if (buf) parts.push({ text: buf, hit });
  return (
    <span className={className} data-testid="snippet">
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-amber-200/70 px-0.5 font-semibold text-foreground">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}

/** What the person can rely on for this document's text search. */
export function contentStatusLabel(status: ContentStatus, reason: string | null): string {
  switch (status) {
    case "indexed":
      return reason === "truncated" ? "Searchable (first part of the text only)" : "Searchable";
    case "pending":
      return "Not indexed yet — searchable by name only";
    case "unsupported":
      return `Not searchable by text — ${(REASON_LABELS[reason ?? ""] ?? "no text could be read.").replace(/\.$/, "")}`;
    default:
      return `Not indexed — ${(REASON_LABELS[reason ?? ""] ?? "indexing failed").replace(/\.$/, "")}`;
  }
}
