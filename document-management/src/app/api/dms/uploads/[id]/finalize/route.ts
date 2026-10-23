import { z } from "zod";
import { readJson, route } from "@/lib/dms/server/respond";
import { uuid } from "@/lib/dms/validation";

export async function POST(req: Request, ctx: RouteContext<"/api/dms/uploads/[id]/finalize">) {
  const { id } = await ctx.params;
  const body = await readJson(req);
  return route(req, ({ service }) => {
    const { versionNumber } = z.object({ versionNumber: z.number().int().min(1) }).parse(body);
    return service.finalizeUpload(uuid.parse(id), versionNumber);
  });
}
