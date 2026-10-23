"use client";

import { useId, useState } from "react";
import { Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { tagName } from "@/lib/dms/validation";

export function TagEditor({
  tags,
  suggestions,
  readOnly,
  onChange,
}: {
  tags: string[];
  suggestions: string[];
  readOnly?: boolean;
  onChange: (tags: string[]) => Promise<unknown> | void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const listId = useId();

  async function add(raw: string) {
    const parsed = tagName.safeParse(raw.replace(/^#/, ""));
    if (!raw.trim()) return;
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid tag");
      return;
    }
    if (tags.some((t) => t.toLowerCase() === parsed.data.toLowerCase())) {
      setText("");
      setError("");
      return;
    }
    if (tags.length >= 20) {
      setError("A document can have up to 20 tags.");
      return;
    }
    setError("");
    setText("");
    await onChange([...tags, parsed.data]);
  }

  return (
    <div>
      <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
        {tags.length === 0 && <li className="text-xs text-muted-foreground">No tags yet</li>}
        {tags.map((t) => (
          <li key={t}>
            <Badge className="gap-1 py-1 pl-2 pr-1 text-xs">
              #{t}
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`Remove tag ${t}`}
                  onClick={() => onChange(tags.filter((x) => x !== t))}
                  className="flex size-4 items-center justify-center rounded-full hover:bg-violet-200/70"
                >
                  <X className="size-3" />
                </button>
              )}
            </Badge>
          </li>
        ))}
      </ul>
      {!readOnly && (
        <div className="mt-2">
          <div className="flex gap-2">
            <Input
              value={text}
              list={listId}
              maxLength={32}
              placeholder="Add a tag and press Enter"
              aria-label="Add tag"
              aria-invalid={!!error}
              onChange={(e) => {
                setText(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  void add(text);
                }
              }}
              className="h-9"
            />
            <button
              type="button"
              aria-label="Add tag"
              onClick={() => void add(text)}
              className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card hover:bg-muted"
            >
              <Plus className="size-4" />
            </button>
          </div>
          <datalist id={listId}>
            {suggestions
              .filter((s) => !tags.includes(s))
              .map((s) => (
                <option key={s} value={s} />
              ))}
          </datalist>
          {error && (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
