"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FolderWithCount } from "@/lib/dms/types";
import { FOLDER_STYLES } from "./folder-style";
import { cn } from "@/lib/utils";

const NONE = "__none__";

export function FolderPicker({
  folders,
  value,
  onChange,
  id,
  disabled,
  noneLabel = "No folder (All Files)",
  ariaLabel = "Folder",
  className,
}: {
  folders: FolderWithCount[];
  value: string | null;
  onChange: (folderId: string | null) => void;
  id?: string;
  disabled?: boolean;
  noneLabel?: string;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)} disabled={disabled}>
      <SelectTrigger id={id} aria-label={ariaLabel} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{noneLabel}</SelectItem>
        {folders.map((f) => (
          <SelectItem key={f.id} value={f.id}>
            <span className="flex items-center gap-2">
              <span className={cn("size-2.5 rounded-full", FOLDER_STYLES[f.color].dot)} aria-hidden />
              {f.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
