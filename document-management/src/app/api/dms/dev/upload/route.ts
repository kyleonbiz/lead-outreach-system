import { loadUploadLimits } from "@/lib/dms/config";
import { devModeAllowed, getSupabaseEnv } from "@/lib/supabase/env";
import { getDevKit } from "@/lib/dms/server/dev-store";
import { json } from "@/lib/dms/server/respond";

export const dynamic = "force-dynamic";

/** Development mode only: receives the raw bytes for a pending upload into server memory. */
export async function PUT(req: Request) {
  if (getSupabaseEnv() || !devModeAllowed()) return json({ ok: false, error: { code: "not_found", message: "Not found." } }, 404);
  const key = new URL(req.url).searchParams.get("key") ?? "";
  const kit = getDevKit();
  const pending = [...kit.store.versions.values()].flat().find((v) => v.storageKey === key && v.status === "pending");
  if (!pending) return json({ ok: false, error: { code: "not_found", message: "No pending upload for that key." } }, 404);
  const limits = loadUploadLimits();
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > limits.maxFileSizeBytes) return json({ ok: false, error: { code: "validation", message: "File too large." } }, 413);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > limits.maxFileSizeBytes) return json({ ok: false, error: { code: "validation", message: "File too large." } }, 413);
  kit.storage.put(key, bytes, pending.mimeType);
  return json({ ok: true, data: null });
}
