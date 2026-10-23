import "server-only";
import { toDmsError } from "../errors";
import { getDms, type Dms } from "./context";

const NO_STORE = { "cache-control": "no-store" };

/** Storage object keys are internal; they are never sent to the browser. */
const hideInternal = (key: string, value: unknown) => (key === "storageKey" ? undefined : value);

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, hideInternal), {
    status,
    headers: { ...NO_STORE, "content-type": "application/json" },
  });
}

/** Cookie-authenticated mutations must come from our own origin. */
function sameOrigin(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

export async function readJson(req: Request): Promise<unknown> {
  if (!req.headers.get("content-type")?.includes("application/json")) return {};
  try {
    return await req.json();
  } catch {
    return {};
  }
}

/** Wraps a handler: authenticates, converts every failure to a safe JSON envelope. */
export async function route<T>(req: Request, fn: (dms: Dms) => Promise<T>): Promise<Response> {
  try {
    if (!sameOrigin(req)) return json({ ok: false, error: { code: "forbidden", message: "Cross-origin request blocked." } }, 403);
    const dms = await getDms();
    const data = await fn(dms);
    return json({ ok: true, data: data ?? null });
  } catch (e) {
    const err = toDmsError(e);
    // Log the error class only: messages can contain file names or row data.
    if (err.code === "internal") console.error("[dms] unhandled error:", e instanceof Error ? e.name : typeof e);
    return json({ ok: false, error: { code: err.code, message: err.message } }, err.status);
  }
}
