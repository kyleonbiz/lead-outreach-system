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
  /** Human noun used in headings, e.g. "Spreadsheet". */
  noun: string;
  Icon: LucideIcon;
  /** Pastel tile + icon colour. */
  tile: string;
  previewable: "image" | "pdf" | "text" | null;
}

const KINDS: Record<string, FileKind> = {
  pdf: { id: "pdf", label: "PDF", noun: "PDF Document", Icon: FileText, tile: "bg-rose-100/80 text-rose-500", previewable: "pdf" },
  word: { id: "word", label: "Word", noun: "Word Document", Icon: FileType2, tile: "bg-blue-100/80 text-blue-500", previewable: null },
  excel: { id: "excel", label: "Excel", noun: "Spreadsheet", Icon: FileSpreadsheet, tile: "bg-teal-100/80 text-teal-600", previewable: null },
  csv: { id: "csv", label: "CSV", noun: "Spreadsheet", Icon: FileSpreadsheet, tile: "bg-emerald-100/80 text-emerald-600", previewable: "text" },
  image: { id: "image", label: "Image", noun: "Image", Icon: FileImage, tile: "bg-amber-100/80 text-amber-600", previewable: "image" },
  other: { id: "other", label: "File", noun: "File", Icon: FileIcon, tile: "bg-slate-100 text-slate-500", previewable: null },
};

export function fileKindOf(mimeType: string, filename: string): FileKind {
  const kind = KINDS[fileTypeGroupOf(mimeType, filename)] ?? KINDS.other;
  if (kind.id === "other" && getExtension(filename) === "txt") {
    return { ...kind, label: "Text", noun: "Text file", Icon: FileText, previewable: "text" };
  }
  return kind;
}
