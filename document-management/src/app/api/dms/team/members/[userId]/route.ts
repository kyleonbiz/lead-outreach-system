import { readJson, route } from "@/lib/dms/server/respond";
import { uuid } from "@/lib/dms/validation";

export async function PATCH(req: Request, ctx: RouteContext<"/api/dms/team/members/[userId]">) {
  const { userId } = await ctx.params;
  const body = await readJson(req);
  return route(req, ({ service }) => service.changeMemberRole(uuid.parse(userId), body));
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/dms/team/members/[userId]">) {
  const { userId } = await ctx.params;
  return route(req, ({ service }) => service.removeMember(uuid.parse(userId)));
}
