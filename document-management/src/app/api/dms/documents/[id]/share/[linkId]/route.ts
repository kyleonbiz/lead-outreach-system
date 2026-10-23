import { route } from "@/lib/dms/server/respond";
import { uuid } from "@/lib/dms/validation";

export async function DELETE(req: Request, ctx: RouteContext<"/api/dms/documents/[id]/share/[linkId]">) {
  const { id, linkId } = await ctx.params;
  return route(req, ({ service }) => service.revokeShareLink(uuid.parse(id), uuid.parse(linkId)));
}
