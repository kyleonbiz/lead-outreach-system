import { NextResponse } from "next/server";
import { sha256Hex } from "@/lib/dms/service";
import { sanitizeFilename } from "@/lib/dms/validation";
import { PUBLIC_SHARE_RATE, checkRate, clientKey } from "@/lib/dms/server/rate-limit";
import { DOCUMENTS_BUCKET } from "@/lib/dms/supabase/storage";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const text = (body: string, status: number) =>
  new NextResponse(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/**
 * Public, unauthenticated download for an unexpired share link. The token is
 * 256 random bits and only its SHA-256 hash is stored. Uses the service-role
 * key server-side only, and redirects to a 60-second signed URL. Each use is
 * audit-logged by `dms_resolve_share`; requests are rate-limited per client
 * address (in memory, per instance).
 */
export async function GET(req: Request, ctx: RouteContext<"/share/[token]">) {
  const limited = checkRate(clientKey(req), PUBLIC_SHARE_RATE);
  if (!limited.ok) {
    const res = text("Too many requests. Try again shortly.", 429);
    res.headers.set("retry-after", String(limited.retryAfterSec));
    return res;
  }
  const { token } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return text("This link is not valid.", 404);
  const admin = createServiceSupabase();
  if (!admin) return text("Sharing is not configured.", 503);

  const { data, error } = await admin.rpc("dms_resolve_share", { p_token_hash: await sha256Hex(token) });
  if (error) return text("Something went wrong.", 500);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return text("This link is invalid or has expired.", 404);

  const signed = await admin.storage.from(DOCUMENTS_BUCKET).createSignedUrl(row.storage_key, 60, { download: sanitizeFilename(String(row.display_name ?? "")) || "download" });
  if (signed.error || !signed.data) return text("The file is not available.", 404);
  return NextResponse.redirect(signed.data.signedUrl, { status: 302, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
