import "server-only";
import { randomBytes } from "node:crypto";
import { MemoryRepository, MemoryStorage, MemoryStore } from "../memory/store";
import { createSampleSynthesizer, seedSampleStore } from "../memory/sample-data";

interface Download {
  key: string;
  fileName: string;
  disposition: "inline" | "attachment";
  expiresAt: number;
}

export interface DevKit {
  store: MemoryStore;
  repo: MemoryRepository;
  storage: MemoryStorage;
  downloads: Map<string, Download>;
}

const g = globalThis as unknown as { __dmsDevKit?: DevKit };

/** Process-wide in-memory workspace used only when Supabase is not configured. */
export function getDevKit(): DevKit {
  if (g.__dmsDevKit) return g.__dmsDevKit;
  const store = seedSampleStore();
  const downloads = new Map<string, Download>();
  const storage = new MemoryStorage(store, {
    synthesize: createSampleSynthesizer(store),
    uploadUrl: (key) => `/api/dms/dev/upload?key=${encodeURIComponent(key)}`,
    downloadUrl: (key, o) => {
      const token = randomBytes(24).toString("base64url");
      downloads.set(token, {
        key,
        fileName: o.fileName,
        disposition: o.disposition,
        expiresAt: Date.now() + o.ttlSeconds * 1000,
      });
      return `/api/dms/dev/file?token=${token}`;
    },
  });
  g.__dmsDevKit = { store, repo: new MemoryRepository(store), storage, downloads };
  return g.__dmsDevKit;
}
