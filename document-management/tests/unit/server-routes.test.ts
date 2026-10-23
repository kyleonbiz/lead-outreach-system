import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDms: vi.fn(),
  admin: null as null | Record<string, unknown>,
}));
vi.mock("@/lib/dms/server/context", async (orig) => ({
  ...(await orig<typeof import("@/lib/dms/server/context")>()),
  getDms: mocks.getDms,
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: vi.fn(),
  createServiceSupabase: () => mocks.admin,
}));

import { POST as cleanupPost, GET as cleanupGet, pendingMaxAgeHours, secretMatches } from "@/app/api/maintenance/cleanup-uploads/route";
import { GET as shareGet } from "@/app/share/[token]/route";
import { acceptPendingInvites } from "@/lib/dms/server/context";
import { INVITE_RATE, MUTATION_RATE, checkRate, clientKey, resetRateLimits } from "@/lib/dms/server/rate-limit";
import { route } from "@/lib/dms/server/respond";
import { sha256Hex } from "@/lib/dms/service";

beforeEach(() => {
  resetRateLimits();
  mocks.admin = null;
  mocks.getDms.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("rate limiter", () => {
  const rule = { name: "t", max: 3, windowMs: 1000 };
  it("allows up to max per window, then reports when to retry", () => {
    expect([1, 2, 3].map(() => checkRate("u", rule, 1000).ok)).toEqual([true, true, true]);
    const blocked = checkRate("u", rule, 1500);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBe(1);
  });
  it("is a sliding window: capacity returns as old hits age out", () => {
    for (const t of [0, 100, 200]) checkRate("u", rule, t);
    expect(checkRate("u", rule, 900).ok).toBe(false);
    expect(checkRate("u", rule, 1001).ok).toBe(true); // the hit at t=0 left the window
    expect(checkRate("u", rule, 1002).ok).toBe(false);
  });
  it("keeps callers and rule names independent", () => {
    for (let i = 0; i < 3; i++) checkRate("a", rule, 0);
    expect(checkRate("a", rule, 1).ok).toBe(false);
    expect(checkRate("b", rule, 1).ok).toBe(true);
    expect(checkRate("a", { ...rule, name: "other" }, 1).ok).toBe(true);
  });
  it("uses the first forwarded address as the client key", () => {
    expect(clientKey(new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } }))).toBe("1.2.3.4");
    expect(clientKey(new Request("http://x"))).toBe("unknown");
  });
});

describe("route(): per-user mutation rate limiting", () => {
  const dms = (userId: string) => ({ mode: "dev", userId, service: {} });
  const post = () => new Request("http://localhost/api/dms/x", { method: "POST" });
  const get = () => new Request("http://localhost/api/dms/x");

  it("returns 429 with Retry-After once the general mutation limit is exceeded", async () => {
    mocks.getDms.mockResolvedValue(dms("u1"));
    for (let i = 0; i < MUTATION_RATE.max; i++) {
      expect((await route(post(), async () => "ok")).status).toBe(200);
    }
    const res = await route(post(), async () => "ok");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ ok: false, error: { code: "rate_limited", message: expect.stringMatching(/too many/i) } });
  });
  it("does not run the handler when limited", async () => {
    mocks.getDms.mockResolvedValue(dms("u2"));
    const fn = vi.fn(async () => "ok");
    for (let i = 0; i < MUTATION_RATE.max + 5; i++) await route(post(), fn);
    expect(fn).toHaveBeenCalledTimes(MUTATION_RATE.max);
  });
  it("never limits reads, and limits users independently", async () => {
    mocks.getDms.mockResolvedValue(dms("u3"));
    for (let i = 0; i < MUTATION_RATE.max + 10; i++) expect((await route(get(), async () => 1)).status).toBe(200);
    mocks.getDms.mockResolvedValue(dms("u4"));
    expect((await route(post(), async () => 1)).status).toBe(200);
  });
  it("applies a stricter per-route rule on top", async () => {
    mocks.getDms.mockResolvedValue(dms("u5"));
    const codes: number[] = [];
    for (let i = 0; i < INVITE_RATE.max + 2; i++) codes.push((await route(post(), async () => 1, { rate: INVITE_RATE })).status);
    expect(codes.filter((c) => c === 200)).toHaveLength(INVITE_RATE.max);
    expect(codes.at(-1)).toBe(429);
  });
});

describe("GET /share/[token]", () => {
  const token = "T".repeat(43);
  const call = (t = token, ip = "9.9.9.9") =>
    shareGet(new Request(`http://localhost/share/${t}`, { headers: { "x-forwarded-for": ip } }), { params: Promise.resolve({ token: t }) } as never);
  const admin = (row: unknown, signed: unknown = { data: { signedUrl: "https://sb.test/signed?x=1" }, error: null }) => {
    const rpc = vi.fn(async () => ({ data: row ? [row] : [], error: null }));
    const createSignedUrl = vi.fn(async () => signed);
    mocks.admin = { rpc, storage: { from: vi.fn(() => ({ createSignedUrl })) } };
    return { rpc, createSignedUrl };
  };
  const row = { storage_key: "ws/doc/v1-a.pdf", display_name: "a.pdf" };

  it("resolves by token hash (never the raw token) and redirects to a 60s signed URL", async () => {
    const { rpc, createSignedUrl } = admin(row);
    const res = await call();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://sb.test/signed?x=1");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(rpc).toHaveBeenCalledWith("dms_resolve_share", { p_token_hash: await sha256Hex(token) });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(token);
    expect(createSignedUrl).toHaveBeenCalledWith("ws/doc/v1-a.pdf", 60, { download: "a.pdf" });
  });
  it("returns 404 for malformed, unknown, revoked or expired tokens without touching the database", async () => {
    const { rpc } = admin(null);
    expect((await call("short")).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
    expect((await call()).status).toBe(404); // resolve returned no row (revoked/expired/unknown)
  });
  it("is 503 when sharing is not configured", async () => {
    expect((await call()).status).toBe(503);
  });
  it("rate-limits each client address", async () => {
    admin(null);
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await call(token, "5.5.5.5")).status;
    expect(last).toBe(429);
    expect((await call(token, "6.6.6.6")).status).toBe(404); // another address is unaffected
  });
});

describe("cleanup route (CRON_SECRET)", () => {
  const SECRET = "s".repeat(32);
  const req = (headers: Record<string, string> = {}, method = "POST") =>
    new Request("http://localhost/api/maintenance/cleanup-uploads", { method, headers });

  it("compares secrets without early exit", () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(SECRET + "x", SECRET)).toBe(false);
    expect(secretMatches("", SECRET)).toBe(false);
    expect(secretMatches(null, SECRET)).toBe(false);
  });
  it("reads the age window from the environment, never below the signed-URL lifetime", () => {
    expect(pendingMaxAgeHours({})).toBe(24);
    expect(pendingMaxAgeHours({ DMS_PENDING_UPLOAD_MAX_AGE_HOURS: "48" })).toBe(48);
    expect(pendingMaxAgeHours({ DMS_PENDING_UPLOAD_MAX_AGE_HOURS: "1" })).toBe(24);
    expect(pendingMaxAgeHours({ DMS_PENDING_UPLOAD_MAX_AGE_HOURS: "abc" })).toBe(24);
  });
  it("refuses to run when CRON_SECRET is unset or weak", async () => {
    expect((await cleanupPost(req({ authorization: "Bearer anything" }))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "short");
    expect((await cleanupPost(req({ authorization: "Bearer short" }))).status).toBe(503);
  });
  it("rejects missing and wrong secrets before touching the database", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const rpc = vi.fn();
    mocks.admin = { rpc };
    expect((await cleanupPost(req())).status).toBe(401);
    expect((await cleanupPost(req({ authorization: "Bearer nope" }))).status).toBe(401);
    expect((await cleanupGet(req({ "x-cron-secret": "nope" }, "GET"))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("deletes stale rows then objects, in batches, and reports counts only", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const keys = Array.from({ length: 150 }, (_, i) => `ws/doc${i}/v1-n.pdf`);
    const remove = vi.fn(async () => ({ data: [], error: null }));
    const rpc = vi.fn(async () => ({ data: keys, error: null }));
    mocks.admin = { rpc, storage: { from: vi.fn(() => ({ remove })) } };
    const res = await cleanupGet(req({ authorization: `Bearer ${SECRET}` }, "GET")); // Vercel Cron style
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("dms_cleanup_stale_uploads", { p_older_than: "24 hours" });
    expect(remove).toHaveBeenCalledTimes(2);
    const body = await res.json();
    expect(body).toEqual({ ok: true, olderThanHours: 24, staleVersions: 150, objectsRemoved: 150, objectsFailed: 0 });
    expect(JSON.stringify(body)).not.toContain("doc0");
    // The x-cron-secret header works too.
    expect((await cleanupPost(req({ "x-cron-secret": SECRET }))).status).toBe(200);
  });
  it("counts storage failures instead of hiding them", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    mocks.admin = {
      rpc: vi.fn(async () => ({ data: ["a", "b"], error: null })),
      storage: { from: vi.fn(() => ({ remove: vi.fn(async () => ({ data: null, error: { message: "x" } })) })) },
    };
    const body = await (await cleanupPost(req({ authorization: `Bearer ${SECRET}` }))).json();
    expect(body).toMatchObject({ ok: true, objectsRemoved: 0, objectsFailed: 2 });
  });
  it("returns a generic 500 when the database call fails", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    mocks.admin = { rpc: vi.fn(async () => ({ data: null, error: { message: "secret detail" } })) };
    const res = await cleanupPost(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret detail");
  });
});

describe("acceptPendingInvites", () => {
  it("calls the RPC with the display name and returns how many invites were accepted", async () => {
    const rpc = vi.fn(async () => ({ data: 2, error: null }));
    expect(await acceptPendingInvites({ rpc } as never, "Frank")).toBe(2);
    expect(rpc).toHaveBeenCalledWith("dms_accept_invites", { p_display_name: "Frank" });
  });
  it("never blocks sign-in on failure", async () => {
    expect(await acceptPendingInvites({ rpc: async () => ({ data: null, error: { message: "x" } }) } as never, "F")).toBe(0);
  });
});
