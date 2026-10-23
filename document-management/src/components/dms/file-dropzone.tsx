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
        "relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors",
        over ? "border-violet-400 bg-violet-50" : "border-input bg-muted/30 hover:bg-muted/50",
        disabled && "pointer-events-none opacity-60",
      )}
      data-testid="dropzone"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-100 to-violet-100 text-violet-600">
        <CloudUpload className="size-6" aria-hidden />
      </span>
      <p className="mt-3 text-sm font-medium">{over ? "Drop to upload" : "Drag and drop files here"}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">or</p>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={disabled}
        className="mt-1 rounded-md px-2 py-1 text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        Browse files
      </button>
      <p className="mt-2 text-[11px] text-muted-foreground">{hint}</p>
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
