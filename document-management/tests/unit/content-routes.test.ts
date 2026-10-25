import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: null as unknown,
  getDms: vi.fn(),
  after: vi.fn(),
}));
vi.mock("@/lib/dms/server/context", () => ({ getDms: mocks.getDms }));
vi.mock("@/lib/supabase/server", () => ({ createServiceSupabase: () => mocks.admin }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: mocks.after }));

import { GET as bootstrapGet } from "@/app/api/dms/bootstrap/route";
import { POST as finalizePost } from "@/app/api/dms/uploads/[id]/finalize/route";
import { GET as reindexGet, POST as reindexPost } from "@/app/api/maintenance/reindex/route";
import { resetRateLimits } from "@/lib/dms/server/rate-limit";

const SECRET = "s".repeat(32);
const DOC = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  resetRateLimits();
  mocks.admin = null;
  mocks.getDms.mockReset();
  mocks.after.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("finalize route", () => {
  const call = () =>
    finalizePost(
      new Request(`http://localhost/api/dms/uploads/${DOC}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ versionNumber: 2 }),
      }),
      { params: Promise.resolve({ id: DOC }) } as never,
    );

  it("answers immediately and schedules indexing for after the response", async () => {
    const service = {
      finalizeUpload: vi.fn(async () => ({ id: DOC, currentVersion: 2, contentStatus: "pending" })),
      indexDocument: vi.fn(async () => "indexed"),
    };
    mocks.getDms.mockResolvedValue({ userId: "u", service });
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ id: DOC, contentStatus: "pending" });
    expect(service.indexDocument).not.toHaveBeenCalled(); // not run inline
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(service.indexDocument).toHaveBeenCalledWith(DOC, 2);
  });

  it("does not schedule indexing when finalize fails", async () => {
    const service = { finalizeUpload: vi.fn(async () => Promise.reject(new Error("nope"))), indexDocument: vi.fn() };
    mocks.getDms.mockResolvedValue({ userId: "u", service });
    expect((await call()).status).toBe(500);
    expect(mocks.after).not.toHaveBeenCalled();
  });
});

describe("bootstrap route", () => {
  const req = () => new Request("http://localhost/api/dms/bootstrap");
  it("lets editors quietly index a few pending documents", async () => {
    const service = { bootstrap: vi.fn(async () => ({ role: "editor" })), indexPending: vi.fn(async () => ({})) };
    mocks.getDms.mockResolvedValue({ userId: "u", service });
    expect((await bootstrapGet(req())).status).toBe(200);
    await mocks.after.mock.calls[0][0]();
    expect(service.indexPending).toHaveBeenCalledWith({ limit: 5 });
  });
  it("does nothing extra for viewers", async () => {
    const service = { bootstrap: vi.fn(async () => ({ role: "viewer" })), indexPending: vi.fn() };
    mocks.getDms.mockResolvedValue({ userId: "u", service });
    await bootstrapGet(req());
    expect(mocks.after).not.toHaveBeenCalled();
  });
  it("a failing background index never surfaces", async () => {
    const service = { bootstrap: vi.fn(async () => ({ role: "owner" })), indexPending: vi.fn(async () => Promise.reject(new Error("x"))) };
    mocks.getDms.mockResolvedValue({ userId: "u", service });
    await bootstrapGet(req());
    await expect(mocks.after.mock.calls[0][0]()).resolves.toBeUndefined();
  });
});

describe("reindex route (CRON_SECRET)", () => {
  const req = (headers: Record<string, string> = {}, qs = "", method = "POST") =>
    new Request(`http://localhost/api/maintenance/reindex${qs}`, { method, headers });

  it("refuses to run when CRON_SECRET is unset or weak", async () => {
    expect((await reindexPost(req({ authorization: "Bearer x" }))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "short");
    expect((await reindexPost(req({ authorization: "Bearer short" }))).status).toBe(503);
  });
  it("rejects missing and wrong secrets before touching the database", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const rpc = vi.fn();
    mocks.admin = { rpc };
    expect((await reindexPost(req())).status).toBe(401);
    expect((await reindexGet(req({ authorization: "Bearer nope" }, "", "GET"))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("is unavailable without a service-role client", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await reindexPost(req({ authorization: `Bearer ${SECRET}` }))).status).toBe(503);
  });
  it("lists with a clamped limit and reports counts only", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    mocks.admin = { rpc };
    const res = await reindexPost(req({ authorization: `Bearer ${SECRET}` }, "?limit=9999&retryFailed=1"));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("dms_service_list_unindexed", { p_limit: 100, p_include_failed: true });
    expect(await res.json()).toEqual({ ok: true, found: 0, indexed: 0, unsupported: 0, failed: 0, skipped: 0, incomplete: false });
    await reindexPost(req({ "x-cron-secret": SECRET }, "?limit=abc"));
    expect(rpc).toHaveBeenLastCalledWith("dms_service_list_unindexed", { p_limit: 20, p_include_failed: false });
  });
  it("returns a generic 500 when listing fails", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    mocks.admin = { rpc: vi.fn(async () => ({ data: null, error: { message: "secret detail" } })) };
    const res = await reindexPost(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret detail");
  });
});
