import { readJson, route } from "@/lib/dms/server/respond";
import { uuid } from "@/lib/dms/validation";

export async function PATCH(req: Request, ctx: RouteContext<"/api/dms/folders/[id]">) {
  const { id } = await ctx.params;
  const body = await readJson(req);
  return route(req, ({ service }) => service.renameFolder(uuid.parse(id), body));
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/dms/folders/[id]">) {
  const { id } = await ctx.params;
  return route(req, ({ service }) => service.deleteFolder(uuid.parse(id)));
}
