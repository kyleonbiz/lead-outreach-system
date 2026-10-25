"use client";

import { useRef, useState } from "react";
import { CloudUpload } from "lucide-react";
import { cn } from "@/lib/utils";

export function FileDropzone({
  accept,
  hint,
  disabled,
  onFiles,
}: {
  accept: string;
  hint: string;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  // dragenter/leave fire for children too; count to avoid flicker.
  const depth = useRef(0);

  return (
    <div
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        if (!disabled && e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files));
      }}
      className={cn(
        "relative rounded-2xl border-2 border-dashed transition-colors",
        over ? "border-indigo-400 bg-indigo-50" : "border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/30",
        disabled && "pointer-events-none opacity-60",
      )}
      data-testid="dropzone"
    >
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={disabled}
        className="flex w-full flex-col items-center justify-center rounded-2xl px-4 py-9 text-center focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-12 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
          <CloudUpload className="size-6" aria-hidden />
        </span>
        <span className="mt-3 text-sm font-bold">{over ? "Drop to upload" : "Drag files here or click to browse"}</span>
        <span className="mt-1.5 text-[11px] text-muted-foreground">{hint}</span>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose files to upload"
        data-testid="file-input"
        onChange={(e) => {
          if (e.target.files?.length) onFiles(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
    </div>
  );
}
