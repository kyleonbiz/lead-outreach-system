import { createHash, timingSafeEqual } from "node:crypto";
import { DOCUMENTS_BUCKET } from "@/lib/dms/supabase/storage";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MIN_HOURS = 3; // signed upload URLs live 2 hours
const DEFAULT_HOURS = 24;

const reply = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** Constant-time comparison that does not leak the secret's length. */
export function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function pendingMaxAgeHours(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.DMS_PENDING_UPLOAD_MAX_AGE_HOURS);
  return Number.isFinite(n) && n >= MIN_HOURS ? Math.floor(n) : DEFAULT_HOURS;
}

/**
 * Removes abandoned pending uploads (database rows via the service-role-only
 * `dms_cleanup_stale_uploads`, then the stored objects). Protected by CRON_SECRET,
 * sent as `Authorization: Bearer <secret>` (what Vercel Cron sends) or `x-cron-secret`.
 * Not under /api/dms, so it bypasses user-session gating on purpose.
 */
async function run(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return reply({ ok: false, error: "Cleanup is not configured." }, 503);
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretMatches(bearer ?? req.headers.get("x-cron-secret"), secret)) {
    return reply({ ok: false, error: "Unauthorized." }, 401);
  }
  const admin = createServiceSupabase();
  if (!admin) return reply({ ok: false, error: "Cleanup is not configured." }, 503);

  const hours = pendingMaxAgeHours();
  const { data, error } = await admin.rpc("dms_cleanup_stale_uploads", { p_older_than: `${hours} hours` });
  if (error) return reply({ ok: false, error: "Cleanup failed." }, 500);

  const keys = (data as string[] | null) ?? [];
  let objectsRemoved = 0;
  let objectsFailed = 0;
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const res = await admin.storage.from(DOCUMENTS_BUCKET).remove(batch);
    if (res.error) objectsFailed += batch.length;
    else objectsRemoved += batch.length;
  }
  // Counts only: keys and file names are never returned or logged.
  return reply({ ok: true, olderThanHours: hours, staleVersions: keys.length, objectsRemoved, objectsFailed }, 200);
}

export const GET = run;
export const POST = run;
