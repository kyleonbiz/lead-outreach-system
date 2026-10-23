import { route } from "@/lib/dms/server/respond";
import { uuid } from "@/lib/dms/validation";

export async function POST(req: Request, ctx: RouteContext<"/api/dms/documents/[id]/purge">) {
  const { id } = await ctx.params;
  return route(req, ({ service }) => service.purgeDocument(uuid.parse(id)));
}
