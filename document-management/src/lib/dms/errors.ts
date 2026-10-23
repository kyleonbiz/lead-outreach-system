export type DmsErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation"
  | "quota_exceeded"
  | "conflict"
  | "storage_failed"
  | "unavailable"
  | "rate_limited"
  | "internal";

const STATUS: Record<DmsErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation: 400,
  quota_exceeded: 413,
  conflict: 409,
  storage_failed: 502,
  unavailable: 503,
  rate_limited: 429,
  internal: 500,
};

export class DmsError extends Error {
  readonly code: DmsErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: DmsErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DmsError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export function isDmsError(e: unknown): e is DmsError {
  return e instanceof DmsError;
}

/** Maps any thrown value to a DmsError without leaking internals. */
export function toDmsError(e: unknown): DmsError {
  if (e instanceof DmsError) return e;
  if (e && typeof e === "object" && "issues" in e && Array.isArray((e as { issues: unknown }).issues)) {
    const issues = (e as { issues: { message?: string; path?: unknown[] }[] }).issues;
    const first = issues[0];
    const where = first?.path?.length ? `${first.path.join(".")}: ` : "";
    return new DmsError("validation", `${where}${first?.message ?? "Invalid input."}`);
  }
  return new DmsError("internal", "Something went wrong. Please try again.");
}
