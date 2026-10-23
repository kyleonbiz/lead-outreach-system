import { devModeAllowed, getSupabaseEnv } from "@/lib/supabase/env";
import { getDevKit } from "@/lib/dms/server/dev-store";

export const dynamic = "force-dynamic";

/** Development mode only: serves a file for a short-lived, unguessable download token. */
export async function GET(req: Request) {
  if (getSupabaseEnv() || !devModeAllowed()) return new Response("Not found", { status: 404 });
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const kit = getDevKit();
  const grant = kit.downloads.get(token);
  if (!grant || grant.expiresAt < Date.now()) {
    kit.downloads.delete(token);
    return new Response("Link expired", { status: 410 });
  }
  const blob = kit.storage.readBlob(grant.key);
  if (!blob) return new Response("Not found", { status: 404 });
  const safeName = grant.fileName.replace(/[^\w.\- ]+/g, "_");
  return new Response(new Uint8Array(blob.bytes), {
    headers: {
      "content-type": blob.mimeType,
      "content-disposition": `${grant.disposition}; filename="${safeName}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
