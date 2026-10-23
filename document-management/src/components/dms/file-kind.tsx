import {
  File as FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  type LucideIcon,
} from "lucide-react";
import { fileTypeGroupOf, getExtension } from "@/lib/dms/validation";

export interface FileKind {
  id: string;
  label: string;
  Icon: LucideIcon;
  /** Pastel tile + icon colour. */
  tile: string;
  previewable: "image" | "pdf" | "text" | null;
}

const KINDS: Record<string, FileKind> = {
  pdf: { id: "pdf", label: "PDF", Icon: FileText, tile: "bg-rose-50 text-rose-500", previewable: "pdf" },
  word: { id: "word", label: "Word", Icon: FileType2, tile: "bg-blue-50 text-blue-500", previewable: null },
  excel: { id: "excel", label: "Excel", Icon: FileSpreadsheet, tile: "bg-emerald-50 text-emerald-600", previewable: null },
  csv: { id: "csv", label: "CSV", Icon: FileSpreadsheet, tile: "bg-teal-50 text-teal-600", previewable: "text" },
  image: { id: "image", label: "Image", Icon: FileImage, tile: "bg-amber-50 text-amber-600", previewable: "image" },
  other: { id: "other", label: "File", Icon: FileIcon, tile: "bg-slate-100 text-slate-500", previewable: null },
};

export function fileKindOf(mimeType: string, filename: string): FileKind {
  const kind = KINDS[fileTypeGroupOf(mimeType, filename)] ?? KINDS.other;
  if (kind.id === "other" && getExtension(filename) === "txt") {
    return { ...kind, label: "Text", Icon: FileText, previewable: "text" };
  }
  return kind;
}
