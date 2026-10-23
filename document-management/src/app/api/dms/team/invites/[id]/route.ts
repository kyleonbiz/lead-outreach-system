import { route } from "@/lib/dms/server/respond";
import { uuid } from "@/lib/dms/validation";

export async function DELETE(req: Request, ctx: RouteContext<"/api/dms/team/invites/[id]">) {
  const { id } = await ctx.params;
  return route(req, ({ service }) => service.revokeInvite(uuid.parse(id)));
}
