export type Role = 'owner' | 'admin' | 'member'
export interface HandlerResult { status: number; body: Record<string, unknown> }

export const fail = (status: number, error: string, extra: Record<string, unknown> = {}): HandlerResult =>
  ({ status, body: { error, ...extra } })
export const ok = (body: Record<string, unknown>): HandlerResult => ({ status: 200, body })

export const isAdmin = (r: Role | null) => r === 'owner' || r === 'admin'
