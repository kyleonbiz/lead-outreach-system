import { readJson, route } from "@/lib/dms/server/respond";
import { uuid } from "@/lib/dms/validation";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: RouteContext<"/api/dms/documents/[id]">) {
  const { id } = await ctx.params;
  return route(req, ({ service }) => service.getDocument(uuid.parse(id)));
}

export async function PATCH(req: Request, ctx: RouteContext<"/api/dms/documents/[id]">) {
  const { id } = await ctx.params;
  const body = await readJson(req);
  return route(req, ({ service }) => service.updateDocument(uuid.parse(id), body));
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/dms/documents/[id]">) {
  const { id } = await ctx.params;
  return route(req, ({ service }) => service.deleteDocument(uuid.parse(id)));
}
