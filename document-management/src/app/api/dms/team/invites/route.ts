import { INVITE_RATE } from "@/lib/dms/server/rate-limit";
import { readJson, route } from "@/lib/dms/server/respond";

export async function POST(req: Request) {
  const body = await readJson(req);
  return route(req, ({ service }) => service.inviteMember(body), { rate: INVITE_RATE });
}
