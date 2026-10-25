import "server-only";
import { toDmsError } from "../errors";
import { getDms, type Dms } from "./context";
import { MUTATION_RATE, checkRate, type RateRule } from "./rate-limit";

const NO_STORE = { "cache-control": "no-store" };

/** Storage object keys are internal; they are never sent to the browser. */
const hideInternal = (key: string, value: unknown) => (key === "storageKey" ? undefined : value);

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body, hideInternal), {
    status,
    headers: { ...NO_STORE, "content-type": "application/json", ...headers },
  });
}

/**
 * Cookie-authenticated mutations must come from our own origin. Browsers always
 * send Origin on cross-site POST/PATCH/DELETE (and Sec-Fetch-Site on modern ones),
 * so a missing header is only tolerated for non-browser clients.
 */
export function sameOrigin(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

const MAX_JSON_BYTES = 256 * 1024;

export async function readJson(req: Request): Promise<unknown> {
  if (!req.headers.get("content-type")?.includes("application/json")) return {};
  // Every JSON body here is small metadata; refuse anything large before parsing it.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_JSON_BYTES) return {};
  try {
    return await req.json();
  } catch {
    return {};
  }
}

/**
 * Wraps a handler: authenticates, rate-limits mutations per user (in-memory,
 * per instance; see rate-limit.ts), and converts every failure to a safe JSON
 * envelope. `opts.rate` adds a stricter limit on top of the general one.
 */
export async function route<T>(
  req: Request,
  fn: (dms: Dms) => Promise<T>,
  opts: { rate?: RateRule } = {},
): Promise<Response> {
  try {
    if (!sameOrigin(req)) return json({ ok: false, error: { code: "forbidden", message: "Cross-origin request blocked." } }, 403);
    const dms = await getDms();
    if (req.method !== "GET" && req.method !== "HEAD") {
      for (const rule of [MUTATION_RATE, opts.rate]) {
        if (!rule) continue;
        const r = checkRate(dms.userId, rule);
        if (!r.ok) {
          return json(
            { ok: false, error: { code: "rate_limited", message: "Too many requests. Please wait a moment and try again." } },
            429,
            { "retry-after": String(r.retryAfterSec) },
          );
        }
      }
    }
    const data = await fn(dms);
    return json({ ok: true, data: data ?? null });
  } catch (e) {
    const err = toDmsError(e);
    // Log the error class only: messages can contain file names or row data.
    if (err.code === "internal") console.error("[dms] unhandled error:", e instanceof Error ? e.name : typeof e);
    return json({ ok: false, error: { code: err.code, message: err.message } }, err.status);
  }
}
