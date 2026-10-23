import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

let currentUser: { id: string } | null = null;
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}));

const supa = {
  user: null as null | { id: string; email: string },
  membership: null as null | { workspace_id: string; role: string; display_name: string },
};
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: supa.user }, error: null }) },
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: supa.membership, error: null });
      return chain;
    },
  }),
  createServiceSupabase: () => null,
}));

import { updateSession } from "@/lib/supabase/proxy";
import { devModeAllowed } from "@/lib/supabase/env";
import { safeNext } from "@/lib/safe-redirect";
import { getDms } from "@/lib/dms/server/context";
import { json, route } from "@/lib/dms/server/respond";
import { DmsError } from "@/lib/dms/errors";

const SUPABASE_ENV = { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk_test" };

beforeEach(() => {
  currentUser = null;
  supa.user = null;
  supa.membership = null;
});
afterEach(() => vi.unstubAllEnvs());

function withSupabase() {
  for (const [k, v] of Object.entries(SUPABASE_ENV)) vi.stubEnv(k, v);
}
const req = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://localhost:3000${path}`, init);

describe("proxy / route gating", () => {
  it("redirects anonymous visitors from /app to /login with a return path", async () => {
    withSupabase();
    const res = await updateSession(req("/app"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/app");
  });
  it("answers anonymous API calls with a 401 envelope, not a redirect", async () => {
    withSupabase();
    const res = await updateSession(req("/api/dms/bootstrap"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
  });
  it("lets signed-in users through and bounces them off /login", async () => {
    withSupabase();
    currentUser = { id: "u1" };
    expect((await updateSession(req("/app"))).status).toBe(200);
    const res = await updateSession(req("/login"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/app");
  });
  it("is a pass-through when Supabase is not configured (dev mode)", async () => {
    expect((await updateSession(req("/app"))).status).toBe(200);
  });
});

describe("open-redirect protection", () => {
  it("only accepts same-site relative paths", () => {
    expect(safeNext("/app?x=1")).toBe("/app?x=1");
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)", "", null, undefined]) {
      expect(safeNext(bad as string)).toBe("/app");
    }
  });
});

describe("development mode guard", () => {
  it("is allowed locally without Supabase", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(devModeAllowed()).toBe(true);
  });
  it("is refused in production unless explicitly forced", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(devModeAllowed()).toBe(false);
    vi.stubEnv("DMS_ALLOW_DEV_MODE", "true");
    expect(devModeAllowed()).toBe(true);
  });
  it("never applies once Supabase is configured", () => {
    withSupabase();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DMS_ALLOW_DEV_MODE", "true");
    expect(devModeAllowed()).toBe(false);
  });
});

describe("getDms (request authentication)", () => {
  it("refuses unauthenticated callers when Supabase is configured", async () => {
    withSupabase();
    await expect(getDms()).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("refuses users without a workspace", async () => {
    withSupabase();
    supa.user = { id: "u1", email: "a@b.co" };
    await expect(getDms()).rejects.toMatchObject({ code: "not_found" });
  });
  it("builds a live service for a member", async () => {
    withSupabase();
    supa.user = { id: "u1", email: "a@b.co" };
    supa.membership = { workspace_id: "00000000-0000-4000-8000-000000000001", role: "viewer", display_name: "A" };
    expect((await getDms()).mode).toBe("live");
  });
  it("is unavailable in production without Supabase", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(getDms()).rejects.toMatchObject({ code: "unavailable" });
  });
  it("serves sample data in development mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { mode, service } = await getDms();
    expect(mode).toBe("dev");
    expect((await service.bootstrap()).workspace.name).toContain("Demo");
  });
});

describe("API envelope", () => {
  it("maps DmsErrors to status codes and never leaks internals", async () => {
    const forbidden = await route(req("/x"), async () => {
      throw new DmsError("forbidden", "nope");
    });
    expect(forbidden.status).toBe(403);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = await route(req("/x"), async () => {
      throw new Error("password=hunter2 at /srv/secret.ts");
    });
    expect(boom.status).toBe(500);
    const text = await boom.text();
    expect(text).not.toContain("hunter2");
    expect(spy.mock.calls.flat().join(" ")).not.toContain("hunter2");
    spy.mockRestore();
  });
  it("blocks cross-origin mutations", async () => {
    const res = await route(
      req("/api/dms/folders", { method: "POST", headers: { origin: "https://evil.example", host: "localhost:3000" } }),
      async () => "done",
    );
    expect(res.status).toBe(403);
  });
  it("never exposes storage keys to the browser", async () => {
    const body = await json({ ok: true, data: { id: "1", storageKey: "ws/doc/v1-x.pdf", nested: [{ storageKey: "k" }] } }).text();
    expect(body).not.toContain("storageKey");
  });
});
