import { vi } from "vitest";

export interface Result {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
}

export interface Call {
  kind: "rpc" | "from";
  name: string;
  /** rpc arguments */
  args?: Record<string, unknown>;
  /** Query-builder steps in order, e.g. ["eq", ["workspace_id", "ws"]]. */
  ops: [string, unknown[]][];
}

/**
 * A recording stand-in for SupabaseClient. `rpc` and `from` results are
 * scripted per function/table; every call and builder step is recorded so tests
 * can assert exactly what the adapter asked the database to do.
 */
export function fakeSupabase(script: {
  rpc?: Record<string, Result | ((args: Record<string, unknown>) => Result)>;
  from?: Record<string, Result | (() => Result)>;
}) {
  const calls: Call[] = [];
  const resolve = (r: Result | ((...a: never[]) => Result) | undefined, ...args: unknown[]): Result => {
    const out = typeof r === "function" ? (r as (...a: unknown[]) => Result)(...args) : r;
    return { data: out?.data ?? null, error: out?.error ?? null };
  };

  const client = {
    rpc(name: string, args: Record<string, unknown> = {}) {
      const call: Call = { kind: "rpc", name, args, ops: [] };
      calls.push(call);
      return Promise.resolve(resolve(script.rpc?.[name], args));
    },
    from(table: string) {
      const call: Call = { kind: "from", name: table, ops: [] };
      calls.push(call);
      const builder: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              return (ok: (v: Result) => unknown, bad: (e: unknown) => unknown) =>
                Promise.resolve(resolve(script.from?.[table])).then(ok, bad);
            }
            return (...a: unknown[]) => {
              call.ops.push([prop, a]);
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };
  const rpcCalls = (name: string) => calls.filter((c) => c.kind === "rpc" && c.name === name);
  const fromCalls = (table: string) => calls.filter((c) => c.kind === "from" && c.name === table);
  return { client: client as never, calls, rpcCalls, fromCalls };
}

export function fakeStorageClient(over: Record<string, unknown> = {}) {
  const bucket = {
    createSignedUploadUrl: vi.fn(async (key: string) => ({ data: { signedUrl: `https://sb.test/upload/${key}?token=t`, token: "t", path: key }, error: null })),
    info: vi.fn(async () => ({ data: { size: 1234, contentType: "application/pdf" }, error: null })),
    createSignedUrl: vi.fn(async (key: string) => ({ data: { signedUrl: `https://sb.test/sign/${key}` }, error: null })),
    remove: vi.fn(async () => ({ data: [], error: null })),
    ...over,
  };
  const from = vi.fn(() => bucket);
  return { client: { storage: { from } } as never, bucket, from };
}
