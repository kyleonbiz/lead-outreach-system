"use client";

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";

/** Debounced search box; the parent only sees settled values. */
export function DocumentSearch({
  value,
  onChange,
  delayMs = 250,
}: {
  value: string;
  onChange: (value: string) => void;
  delayMs?: number;
}) {
  const [text, setText] = useState(value);
  const last = useRef(value);

  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
       
      setText(value);
    }
  }, [value]);

  useEffect(() => {
    if (text === last.current) return;
    const t = setTimeout(() => {
      last.current = text;
      onChange(text);
    }, delayMs);
    return () => clearTimeout(t);
  }, [text, delayMs, onChange]);

  return (
    <div className="relative w-full">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        type="search"
        role="searchbox"
        aria-label="Search documents by name, tag or category"
        placeholder="Search by name, tag or category…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden"
      />
      {text && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setText("");
            last.current = "";
            onChange("");
          }}
          className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
