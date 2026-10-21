import { strToU8, zipSync } from 'fflate'
import { z } from 'zod'
import { fail, isAdmin, type HandlerResult, type Role } from './common.ts'
import type { ActionLogEntry } from '../types.ts'

// Organization data export. Reads go through the CALLER's own token (Row Level Security), so the export can never contain
// anything its requester could not already see in the app. Secrets (OAuth credentials, webhook URLs, invitation token hashes)
// are never selected. Private conversations are not part of an organization export. Documents are exported as metadata only.

/** The only tables an export may read. Ordered newest-first so that, if a cap is hit, the oldest rows are the ones left out. */
export const EXPORT_TABLES = {
  tasks: { cap: 20_000, access: 'member' },
  task_history: { cap: 50_000, access: 'member' },
  documents: { cap: 5_000, access: 'member' },
  knowledge_base_sources: { cap: 5_000, access: 'member' },
  workflows: { cap: 1_000, access: 'member' },
  workflow_versions: { cap: 5_000, access: 'member' },
  approval_requests: { cap: 10_000, access: 'member' },
  notification_channels: { cap: 100, access: 'admin' },
  organization_invitations: { cap: 1_000, access: 'owner' },
  usage_records: { cap: 25_000, access: 'admin' },
  action_logs: { cap: 25_000, access: 'member' },
} as const
export type ExportTable = keyof typeof EXPORT_TABLES
export const PAGE_SIZE = 1000
export const THROTTLE_SECONDS = 300

const AUDIT_COLUMNS = ['created_at', 'actor_type', 'category', 'tool_name', 'action', 'status', 'summary', 'error', 'user_id', 'duration_ms', 'id'] as const

const Request = z.strictObject({ org_id: z.uuid(), scope: z.enum(['all', 'audit']).default('all') })

export interface ExportDeps {
  userId: string | null
  now(): Date
  getRole(orgId: string): Promise<Role | null>
  org(orgId: string): Promise<{ id: string; name: string } | null>
  settings(orgId: string): Promise<Record<string, unknown> | null>
  /** team roster (e-mail addresses are included only for owners/admins by the database function) */
  members(orgId: string): Promise<Array<Record<string, unknown>>>
  /** one page of a whitelisted table, scoped to the organization, newest first */
  rows(table: ExportTable, orgId: string, offset: number, limit: number): Promise<Array<Record<string, unknown>>>
  /** time of this organization's last export, for throttling */
  lastExportAt(orgId: string): Promise<Date | null>
  audit(e: ActionLogEntry): Promise<void>
}

export type ExportResult = HandlerResult | { status: 200; zip: Uint8Array; filename: string }

// ------------------------------------------------------------------------------------------------ CSV
/** Spreadsheet programs run cells that start with = + - @ (or tab/CR) as formulas, and audit text is untrusted. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export function toCsv(rows: Array<Record<string, unknown>>, columns: readonly string[]): string {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n'
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'organization'

async function readAll(d: ExportDeps, table: ExportTable, orgId: string) {
  const { cap } = EXPORT_TABLES[table]
  const out: Array<Record<string, unknown>> = []
  while (out.length < cap) {
    const page = await d.rows(table, orgId, out.length, Math.min(PAGE_SIZE, cap - out.length))
    out.push(...page)
    if (page.length < Math.min(PAGE_SIZE, cap - out.length + page.length)) break
  }
  // truncated when the table holds more than we took (probe one more row)
  const truncated = out.length >= cap && (await d.rows(table, orgId, out.length, 1)).length > 0
  return { rows: out, truncated, cap }
}

const accessible = (access: 'member' | 'admin' | 'owner', role: Role) =>
  access === 'member' || (access === 'admin' && isAdmin(role)) || (access === 'owner' && role === 'owner')

export async function handleExport(d: ExportDeps, raw: unknown): Promise<ExportResult> {
  if (!d.userId) return fail(401, 'Sign in required')
  const p = Request.safeParse(raw)
  if (!p.success) return fail(400, 'Invalid request', { issues: p.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`) })
  const { org_id, scope } = p.data
  const role = await d.getRole(org_id)
  if (!role) return fail(403, 'You are not a member of this organization')
  if (scope === 'all' ? role !== 'owner' : !isAdmin(role)) {
    return fail(403, scope === 'all' ? 'Only owners can export all organization data' : 'Only owners and admins can export the audit log')
  }
  const org = await d.org(org_id)
  if (!org) return fail(404, 'Organization not found')

  const last = await d.lastExportAt(org_id)
  if (last) {
    const wait = THROTTLE_SECONDS - Math.floor((d.now().getTime() - last.getTime()) / 1000)
    if (wait > 0) return fail(429, `An export was just made. Please wait ${wait} seconds before exporting again.`, { code: 'throttled', retry_after_seconds: wait })
  }

  const files: Record<string, Uint8Array> = {}
  const manifest: Record<string, { rows: number; truncated: boolean; cap: number }> = {}
  const tables = (scope === 'audit' ? ['action_logs'] : Object.keys(EXPORT_TABLES)) as ExportTable[]
  for (const t of tables) {
    if (!accessible(EXPORT_TABLES[t].access, role)) continue
    const r = await readAll(d, t, org_id)
    manifest[t] = { rows: r.rows.length, truncated: r.truncated, cap: r.cap }
    files[`${t}.json`] = strToU8(JSON.stringify(r.rows))
    if (t === 'action_logs') files['action_logs.csv'] = strToU8(toCsv(r.rows, AUDIT_COLUMNS))
  }
  if (scope === 'all') {
    files['organization.json'] = strToU8(JSON.stringify({ ...org, settings: await d.settings(org_id) }))
    const members = await d.members(org_id)
    files['members.json'] = strToU8(JSON.stringify(members))
    manifest.members = { rows: members.length, truncated: false, cap: members.length }
  }

  const generatedAt = d.now().toISOString()
  const truncated = Object.entries(manifest).filter(([, v]) => v.truncated).map(([k]) => k)
  files['manifest.json'] = strToU8(JSON.stringify({ generated_at: generatedAt, generated_by: d.userId, organization: org, scope, tables: manifest, truncated }, null, 2))
  files['README.txt'] = strToU8([
    `Export of "${org.name}" (${scope === 'all' ? 'all organization data' : 'audit log only'}), generated ${generatedAt}.`, '',
    'Each .json file is an array of rows exactly as stored. action_logs.csv is the audit log for spreadsheets (cells that look like formulas are prefixed with an apostrophe).',
    scope === 'all' ? 'Documents are exported as metadata only (names, summaries, extracted dates); the uploaded files themselves are not included.' : '',
    scope === 'all' ? 'Not included: private assistant conversations (each person owns theirs), OAuth credentials, webhook URLs and invitation tokens, which are never exported.' : '',
    truncated.length ? `\nINCOMPLETE: ${truncated.join(', ')} hit the export size cap. The newest rows are included; older rows were left out (see manifest.json).` : '',
  ].filter((l) => l !== '').join('\n') + '\n')

  // recorded before the file is handed over, so the throttle holds even if the download is interrupted
  await d.audit({
    org_id, user_id: d.userId, actor_type: 'user', category: 'audit', tool_name: null, action: 'org.exported', status: 'success',
    summary: `Exported ${scope === 'all' ? 'organization data' : 'the audit log'} (${Object.values(manifest).reduce((n, v) => n + v.rows, 0)} rows${truncated.length ? `, incomplete: ${truncated.join(', ')}` : ''})`,
  })
  return { status: 200, zip: zipSync(files, { level: 6 }), filename: `aide-${scope === 'all' ? 'export' : 'audit-log'}-${slug(org.name)}-${generatedAt.slice(0, 10)}.zip` }
}
