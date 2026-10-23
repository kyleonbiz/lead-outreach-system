import { DmsError } from "@/lib/dms/errors";
import { readJson, route } from "@/lib/dms/server/respond";
import { shareLinkSchema, uuid } from "@/lib/dms/validation";
import { getServiceRoleKey } from "@/lib/supabase/env";

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
  });
}
