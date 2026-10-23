import { DmsError } from "@/lib/dms/errors";
import { SHARE_CREATE_RATE } from "@/lib/dms/server/rate-limit";
import { readJson, route } from "@/lib/dms/server/respond";
import { shareLinkSchema, uuid } from "@/lib/dms/validation";
import { getServiceRoleKey } from "@/lib/supabase/env";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: RouteContext<"/api/dms/documents/[id]/share">) {
  const { id } = await ctx.params;
  return route(req, async ({ service, mode }) => {
    // Without the service-role key links cannot be used, so none are offered.
    if (mode !== "live" || !getServiceRoleKey()) return [];
    return service.listShareLinks(uuid.parse(id));
  });
}

export async function POST(req: Request, ctx: RouteContext<"/api/dms/documents/[id]/share">) {
  const { id } = await ctx.params;
  const body = await readJson(req);
  const origin = new URL(req.url).origin;
  return route(req, async ({ service, mode }) => {
    if (mode !== "live" || !getServiceRoleKey()) {
      throw new DmsError("unavailable", "Share links need Supabase with SUPABASE_SERVICE_ROLE_KEY configured.");
    }
    const { ttlMinutes } = shareLinkSchema.parse(body);
    const { token, expiresAt } = await service.createShareLink(uuid.parse(id), ttlMinutes);
    return { url: `${origin}/share/${token}`, expiresAt };
  }, { rate: SHARE_CREATE_RATE });
}
