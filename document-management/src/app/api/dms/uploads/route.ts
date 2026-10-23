import { readJson, route } from "@/lib/dms/server/respond";

export async function POST(req: Request) {
  const body = await readJson(req);
  return route(req, ({ service }) => service.initiateUpload(body));
}
