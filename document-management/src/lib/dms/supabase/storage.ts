import type { SupabaseClient } from "@supabase/supabase-js";
import { DmsError } from "../errors";
import type { ObjectStorage } from "../ports";
import type { FileLink, UploadTarget } from "../types";
import { sanitizeFilename } from "../validation";

export const DOCUMENTS_BUCKET = "documents";

/**
 * Private-bucket storage using the caller's session. Every URL handed out is a
 * short-lived signed URL; the bucket itself is never public.
 */
export class SupabaseStorage implements ObjectStorage {
  constructor(private readonly db: SupabaseClient) {}

  private get bucket() {
    return this.db.storage.from(DOCUMENTS_BUCKET);
  }

  async createUploadTarget(key: string): Promise<UploadTarget> {
    const { data, error } = await this.bucket.createSignedUploadUrl(key);
    if (error || !data) throw new DmsError("storage_failed", "Could not prepare the upload.");
    return { kind: "supabase-signed", url: data.signedUrl, method: "PUT", headers: {} };
  }

  async stat(key: string) {
    const { data, error } = await this.bucket.info(key);
    if (error || !data) return null;
    return { sizeBytes: Number(data.size ?? 0), mimeType: data.contentType ?? null };
  }

  async readHead(key: string, bytes: number) {
    const { data } = await this.bucket.createSignedUrl(key, 30);
    if (!data) return null;
    try {
      const res = await fetch(data.signedUrl, { headers: { Range: `bytes=0-${bytes - 1}` }, cache: "no-store" });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer()).slice(0, bytes);
    } catch {
      return null;
    }
  }

  async read(key: string, maxBytes: number) {
    const { data } = await this.bucket.createSignedUrl(key, 60);
    if (!data) return null;
    try {
      const res = await fetch(data.signedUrl, { cache: "no-store" });
      if (!res.ok || !res.body) return null;
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > maxBytes) {
        await res.body.cancel().catch(() => undefined);
        return { tooLarge: true as const };
      }
      // Count while reading: a missing or wrong Content-Length must not let a large body through.
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { tooLarge: true as const };
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      return { bytes };
    } catch {
      return null;
    }
  }

  async createDownloadUrl(
    key: string,
    o: { fileName: string; disposition: "inline" | "attachment"; ttlSeconds: number },
  ): Promise<FileLink> {
    const { data, error } = await this.bucket.createSignedUrl(
      key,
      o.ttlSeconds,
      // Re-sanitised: a direct database write could have stored an unsafe display name.
      o.disposition === "attachment" ? { download: sanitizeFilename(o.fileName) || "download" } : undefined,
    );
    if (error || !data) throw new DmsError("not_found", "File not available.");
    return { url: data.signedUrl, expiresAt: new Date(Date.now() + o.ttlSeconds * 1000).toISOString() };
  }

  async remove(keys: string[]) {
    if (keys.length === 0) return;
    const { error } = await this.bucket.remove(keys);
    if (error) throw new DmsError("storage_failed", "Could not remove stored files.");
  }
}
