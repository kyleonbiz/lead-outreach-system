import { secretMatches } from "@/app/api/maintenance/cleanup-uploads/route";
import { reindexBatch } from "@/lib/dms/server/reindex";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const reply = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * Backfills searchable text for documents that have none yet (everything uploaded before
 * content search, or whose indexing never ran). `?limit=` (default 20, max 100) bounds one
 * call; `?retryFailed=1` also retries documents whose earlier attempt failed. Call it
 * repeatedly until `found` is 0. Same CRON_SECRET gate as the cleanup route; counts only.
 */
async function run(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return reply({ ok: false, error: "Reindexing is not configured." }, 503);
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretMatches(bearer ?? req.headers.get("x-cron-secret"), secret)) {
    return reply({ ok: false, error: "Unauthorized." }, 401);
  }
  const admin = createServiceSupabase();
  if (!admin) return reply({ ok: false, error: "Reindexing is not configured." }, 503);

  const url = new URL(req.url);
  const asked = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), 100) : 20;
  const includeFailed = url.searchParams.get("retryFailed") === "1";
  try {
    const result = await reindexBatch(admin, { limit, includeFailed, budgetMs: 45_000 });
    return reply({ ok: true, ...result }, 200);
  } catch {
    return reply({ ok: false, error: "Reindexing failed." }, 500);
  }
}

export const GET = run;
export const POST = run;
