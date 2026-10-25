import { after } from "next/server";
import { z } from "zod";
import { readJson, route } from "@/lib/dms/server/respond";
import { uuid } from "@/lib/dms/validation";

// Text extraction runs after the response, so give it room on hosts that cap duration.
export const maxDuration = 60;

export async function POST(req: Request, ctx: RouteContext<"/api/dms/uploads/[id]/finalize">) {
  const { id } = await ctx.params;
  const body = await readJson(req);
  return route(req, async ({ service }) => {
    const { versionNumber } = z.object({ versionNumber: z.number().int().min(1) }).parse(body);
    const doc = await service.finalizeUpload(uuid.parse(id), versionNumber);
    // Indexing is best-effort and must not delay or fail the upload: the document is
    // searchable by name right away and by content once this finishes.
    after(() => service.indexDocument(doc.id, doc.currentVersion));
    return doc;
  });
}
