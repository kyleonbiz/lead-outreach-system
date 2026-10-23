"use client";

import { useState } from "react";
import { Check, Copy, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toDmsError } from "@/lib/dms/errors";
import { formatDateTime } from "./format";

const OPTIONS = [
  { minutes: 60, label: "1 hour" },
  { minutes: 60 * 24, label: "24 hours" },
  { minutes: 60 * 24 * 7, label: "7 days" },
];

export function ShareDialog({
  open,
  fileName,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  fileName: string;
  onOpenChange: (open: boolean) => void;
  onCreate: (ttlMinutes: number) => Promise<{ url: string; expiresAt: string }>;
}) {
  const [ttl, setTtl] = useState(String(OPTIONS[1].minutes));
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  function reset(next: boolean) {
    if (!next) {
      setLink(null);
      setError("");
      setCopied(false);
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent variant="alert">
        <DialogTitle className="flex items-center gap-2">
          <Link2 className="size-5 text-violet-500" aria-hidden /> Share securely
        </DialogTitle>
        <DialogDescription className="mt-1 break-words">
          Create a link to “{fileName}” that stops working automatically.
        </DialogDescription>

        {!link ? (
          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="share-ttl" className="text-sm font-medium">
                Link expires after
              </label>
              <Select value={ttl} onValueChange={setTtl}>
                <SelectTrigger id="share-ttl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPTIONS.map((o) => (
                    <SelectItem key={o.minutes} value={String(o.minutes)}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              Anyone with the link can download this file until it expires. Treat it like a password.
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => reset(false)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    setLink(await onCreate(Number(ttl)));
                  } catch (e) {
                    setError(toDmsError(e).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Creating…" : "Create link"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex gap-2">
              <Input readOnly value={link.url} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} />
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link.url);
                    setCopied(true);
                  } catch {
                    setError("Copy failed. Select the link and copy it manually.");
                  }
                }}
              >
                {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Expires {formatDateTime(link.expiresAt)}</p>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end">
              <Button onClick={() => reset(false)}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
