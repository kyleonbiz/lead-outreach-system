import { route } from "@/lib/dms/server/respond";
import { uuid } from "@/lib/dms/validation";

export async function DELETE(req: Request, ctx: RouteContext<"/api/dms/uploads/[id]">) {
  const { id } = await ctx.params;
  const version = Number(new URL(req.url).searchParams.get("version")) || 1;
  return route(req, ({ service }) => service.abortUpload(uuid.parse(id), version));
}
