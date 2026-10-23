import { route } from "@/lib/dms/server/respond";
import { uuid } from "@/lib/dms/validation";

export const dynamic = "force-dynamic";

/** Returns a short-lived signed URL (after an authorization check); never the file itself. */
export async function GET(req: Request, ctx: RouteContext<"/api/dms/documents/[id]/file">) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const version = Number(url.searchParams.get("version")) || undefined;
  const disposition = url.searchParams.get("disposition") === "inline" ? "inline" : "attachment";
  return route(req, ({ service }) => service.getFileLink(uuid.parse(id), { versionNumber: version, disposition }));
}
