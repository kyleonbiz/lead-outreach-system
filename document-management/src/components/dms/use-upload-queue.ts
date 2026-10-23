"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DmsApi } from "@/lib/dms/client/api";
import { toDmsError } from "@/lib/dms/errors";
import type { Category, DocumentRecord, UploadLimits } from "@/lib/dms/types";
import { validateUploadCandidate } from "@/lib/dms/validation";

export type UploadStatus = "uploading" | "success" | "error" | "cancelled";

export interface UploadItem {
  id: number;
  file: File;
  status: UploadStatus;
  progress: number;
  error?: string;
}

const CONCURRENCY = 2;

export function useUploadQueue(opts: {
  api: DmsApi;
  limits: UploadLimits;
  folderId: string | null;
  category?: Category;
  remainingBytes: number;
  onUploaded: (doc: DocumentRecord) => void;
}) {
  const { api, limits } = opts;
  const [items, setItems] = useState<UploadItem[]>([]);
  const seq = useRef(0);
  const controllers = useRef(new Map<number, AbortController>());
  const pending = useRef<{ id: number; file: File; folderId: string | null; category?: Category }[]>([]);
  const running = useRef(0);
  const live = useRef(opts);
  useEffect(() => {
    live.current = opts;
  });

  const patch = useCallback((id: number, p: Partial<UploadItem>) => {
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...p } : i)));
  }, []);

  const pump = useCallback(() => {
    while (running.current < CONCURRENCY && pending.current.length > 0) {
      const job = pending.current.shift()!;
      const controller = new AbortController();
      controllers.current.set(job.id, controller);
      running.current++;
      api
        .uploadFile({
          file: job.file,
          folderId: job.folderId,
          category: job.category,
          signal: controller.signal,
          onProgress: (loaded, total) => patch(job.id, { progress: total ? Math.round((loaded / total) * 100) : 0 }),
        })
        .then((doc) => {
          patch(job.id, { status: "success", progress: 100 });
          live.current.onUploaded(doc);
        })
        .catch((e) => {
          if (controller.signal.aborted) patch(job.id, { status: "cancelled", error: "Cancelled" });
          else patch(job.id, { status: "error", error: toDmsError(e).message });
        })
        .finally(() => {
          controllers.current.delete(job.id);
          running.current--;
          pump();
        });
    }
  }, [api, patch]);

  const enqueue = useCallback(
    (id: number, file: File) => {
      pending.current.push({ id, file, folderId: live.current.folderId, category: live.current.category });
      pump();
    },
    [pump],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      let budget = live.current.remainingBytes;
      const next: UploadItem[] = [];
      files.forEach((file, index) => {
        const id = ++seq.current;
        let error: string | undefined;
        if (index >= limits.maxFilesPerBatch) {
          error = `You can add up to ${limits.maxFilesPerBatch} files at a time.`;
        } else {
          const check = validateUploadCandidate(file, limits);
          if (!check.ok) error = check.reason;
          else if (file.size > budget) error = "Not enough storage space left.";
          else budget -= file.size;
        }
        next.push({ id, file, status: error ? "error" : "uploading", progress: 0, error });
        if (!error) enqueue(id, file);
      });
      setItems((list) => [...next, ...list]);
    },
    [enqueue, limits],
  );

  const cancel = useCallback(
    (id: number) => {
      const inQueue = pending.current.findIndex((j) => j.id === id);
      if (inQueue >= 0) {
        pending.current.splice(inQueue, 1);
        patch(id, { status: "cancelled", error: "Cancelled" });
      } else controllers.current.get(id)?.abort();
    },
    [patch],
  );

  const retry = useCallback(
    (id: number) => {
      const item = items.find((i) => i.id === id);
      if (!item) return;
      patch(id, { status: "uploading", progress: 0, error: undefined });
      enqueue(id, item.file);
    },
    [enqueue, items, patch],
  );

  const clearFinished = useCallback(() => {
    setItems((list) => list.filter((i) => i.status === "uploading"));
  }, []);

  const busy = items.some((i) => i.status === "uploading");
  return { items, addFiles, cancel, retry, clearFinished, busy };
}
