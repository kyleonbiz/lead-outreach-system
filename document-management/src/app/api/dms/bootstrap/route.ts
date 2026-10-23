import { route } from "@/lib/dms/server/respond";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return route(req, ({ service }) => service.bootstrap());
}
