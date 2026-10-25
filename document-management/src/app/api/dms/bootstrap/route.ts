import { after } from "next/server";
import { can } from "@/lib/dms/service";
import { route } from "@/lib/dms/server/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET(req: Request) {
  return route(req, async ({ service }) => {
    const boot = await service.bootstrap();
    // Documents uploaded before content search existed (or whose indexing never ran) are
    // picked up a few at a time by whoever opens the workspace; editors only, bounded, and
    // failures are not retried here (the maintenance route does that).
    if (can(boot.role, "write")) after(() => service.indexPending({ limit: 5 }).catch(() => undefined));
    return boot;
  });
}
