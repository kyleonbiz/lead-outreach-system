"use client";

import { Folder as FolderIcon, FolderOpen, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FolderColor } from "@/lib/dms/types";
import { cn } from "@/lib/utils";
import { FOLDER_STYLES } from "./folder-style";

export interface FolderCardProps {
  name: string;
  count: number;
  color: FolderColor;
  active: boolean;
  isAll?: boolean;
  onSelect: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}

export function FolderCard({ name, count, color, active, isAll, onSelect, onRename, onDelete }: FolderCardProps) {
  const style = FOLDER_STYLES[color];
  const Icon = isAll || active ? FolderOpen : FolderIcon;
  const hasMenu = Boolean(onRename || onDelete);
  return (
    <div
      className={cn(
        "group relative rounded-xl border bg-card transition-all hover:-translate-y-0.5 hover:shadow-panel",
        active ? "border-indigo-400 bg-indigo-50/70 shadow-panel" : "hover:border-input",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        aria-label={`${name}, ${count} ${count === 1 ? "document" : "documents"}`}
        className="flex w-full items-center gap-3 rounded-xl p-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", style.tile)}>
          <Icon className={cn("size-5", style.icon)} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 pr-5">
          <span className={cn("block truncate text-sm font-semibold", active && "text-indigo-700")}>{name}</span>
          <span className="block text-xs text-muted-foreground tabular-nums">
            {count} {count === 1 ? "file" : "files"}
          </span>
        </span>
      </button>
      {hasMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Folder options for ${name}`}
              className="absolute right-1.5 top-1.5 size-7 text-muted-foreground opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onRename && (
              <DropdownMenuItem onSelect={onRename}>
                <Pencil /> Rename
              </DropdownMenuItem>
            )}
            {onDelete && (
              <DropdownMenuItem destructive onSelect={onDelete}>
                <Trash2 /> Delete folder
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
