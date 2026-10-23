import { route } from "@/lib/dms/server/respond";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  return route(req, ({ service }) => service.listDocuments(parseQuery(params)));
}

function parseQuery(p: Record<string, string>) {
  return {
    view: p.view as never,
    folderId: p.folderId ?? null,
    search: p.search ?? "",
    category: (p.category ?? null) as never,
    fileType: p.fileType ?? null,
    tag: p.tag ?? null,
    sort: p.sort as never,
    page: p.page as never,
    pageSize: p.pageSize as never,
  };
}
