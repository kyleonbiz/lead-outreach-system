import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { csvCell, EXPORT_TABLES, handleExport, PAGE_SIZE, THROTTLE_SECONDS, toCsv, type ExportDeps, type ExportResult, type ExportTable } from './dataExport.ts'
import type { Role } from './common.ts'

const ORG = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-10-21T12:00:00Z')

function world(role: Role | null = 'owner', over: Partial<ExportDeps> = {}, data: Partial<Record<ExportTable, Array<Record<string, unknown>>>> = {}) {
  const reads: Array<{ table: string; org: string; offset: number; limit: number }> = []
  const audits: Array<Record<string, unknown>> = []
  const store: Record<string, Array<Record<string, unknown>>> = {
    tasks: [{ id: 't1', org_id: ORG, title: 'Pay rent' }], action_logs: [{ id: 'l1', org_id: ORG, action: 'x', status: 'success', summary: 'hello', created_at: '2026-10-20T00:00:00Z' }],
    documents: [{ id: 'd1', name: 'contract.pdf', summary: 'A contract' }], ...data,
  }
  const d: ExportDeps = {
    userId: 'u1', now: () => NOW, getRole: async (o) => (o === ORG ? role : null),
    org: async (o) => (o === ORG ? { id: ORG, name: 'Acme & Sons, Inc.' } : null), settings: async () => ({ timezone: 'UTC' }),
    members: async () => [{ user_id: 'u1', role: 'owner', email: 'jane@acme.com' }],
    rows: async (table, org, offset, limit) => { reads.push({ table, org, offset, limit }); return (store[table] ?? []).slice(offset, offset + limit) },
    lastExportAt: async () => null, audit: async (e) => { audits.push(e as unknown as Record<string, unknown>) }, ...over,
  }
  return { d, reads, audits, store }
}
const zipOf = (r: ExportResult) => {
  if (!('zip' in r)) throw new Error(`expected a zip, got ${JSON.stringify(r)}`)
  const files = unzipSync(r.zip)
  return { files, text: (n: string) => strFromU8(files[n]), json: (n: string) => JSON.parse(strFromU8(files[n])), name: r.filename }
}

describe('who may export', () => {
  it('requires sign-in and a valid request', async () => {
    expect((await handleExport(world('owner', { userId: null }).d, { org_id: ORG })).status).toBe(401)
    for (const bad of [null, {}, { org_id: 'x' }, { org_id: ORG, scope: 'everything' }, { org_id: ORG, extra: 1 }]) expect((await handleExport(world().d, bad)).status).toBe(400)
  })
  it('all organization data is for owners only', async () => {
    for (const role of ['admin', 'member'] as const) expect((await handleExport(world(role).d, { org_id: ORG })).status).toBe(403)
    expect((await handleExport(world(null).d, { org_id: ORG })).status).toBe(403)
    expect((await handleExport(world('owner').d, { org_id: ORG })).status).toBe(200)
  })
  it('the audit log may be exported by admins too, but never by members or outsiders', async () => {
    expect((await handleExport(world('admin').d, { org_id: ORG, scope: 'audit' })).status).toBe(200)
    expect((await handleExport(world('member').d, { org_id: ORG, scope: 'audit' })).status).toBe(403)
    expect((await handleExport(world(null).d, { org_id: ORG, scope: 'audit' })).status).toBe(403)
  })
  it('an organization the caller does not belong to is a 403 and nothing is read', async () => {
    const w = world('owner')
    expect((await handleExport(w.d, { org_id: '22222222-2222-4222-8222-222222222222' })).status).toBe(403)
    expect(w.reads).toHaveLength(0)
  })
})

describe('what is exported', () => {
  it('a full export contains every table, the roster, settings and an honest manifest + README', async () => {
    const out = zipOf(await handleExport(world().d, { org_id: ORG }))
    expect(Object.keys(out.files).sort()).toEqual([
      'README.txt', 'action_logs.csv', 'action_logs.json', 'approval_requests.json', 'documents.json', 'knowledge_base_sources.json', 'manifest.json',
      'members.json', 'notification_channels.json', 'organization.json', 'organization_invitations.json', 'task_history.json', 'tasks.json',
      'usage_records.json', 'workflow_versions.json', 'workflows.json',
    ])
    expect(out.json('tasks.json')).toEqual([{ id: 't1', org_id: ORG, title: 'Pay rent' }])
    expect(out.json('organization.json')).toEqual({ id: ORG, name: 'Acme & Sons, Inc.', settings: { timezone: 'UTC' } })
    expect(out.json('manifest.json')).toMatchObject({ generated_at: NOW.toISOString(), generated_by: 'u1', scope: 'all', truncated: [], tables: { tasks: { rows: 1, truncated: false }, members: { rows: 1 } } })
    expect(out.text('README.txt')).toMatch(/metadata only/)
    expect(out.text('README.txt')).toMatch(/OAuth credentials, webhook URLs and invitation tokens, which are never exported/)
    expect(out.name).toBe('aide-export-acme-sons-inc-2026-10-21.zip')
  })
  it('an audit export contains only the log (JSON + CSV) and its manifest', async () => {
    const w = world('admin')
    const out = zipOf(await handleExport(w.d, { org_id: ORG, scope: 'audit' }))
    expect(Object.keys(out.files).sort()).toEqual(['README.txt', 'action_logs.csv', 'action_logs.json', 'manifest.json'])
    expect(out.name).toBe('aide-audit-log-acme-sons-inc-2026-10-21.zip')
    expect(new Set(w.reads.map((r) => r.table))).toEqual(new Set(['action_logs']))
  })
  it('every read is scoped to the requested organization and uses a whitelisted table only', async () => {
    const w = world()
    await handleExport(w.d, { org_id: ORG })
    expect(w.reads.length).toBeGreaterThan(0)
    expect(w.reads.every((r) => r.org === ORG && r.table in EXPORT_TABLES)).toBe(true)
    expect(new Set(w.reads.map((r) => r.table))).toEqual(new Set(Object.keys(EXPORT_TABLES)))
    expect(w.reads.some((r) => /credential|secret|message|conversation|invitation_token/i.test(r.table.replace('organization_invitations', '')))).toBe(false)
  })
  it('role-gated tables are skipped for admins (usage, channels, invitations are not in an admin audit export)', async () => {
    const w = world('admin')
    await handleExport(w.d, { org_id: ORG, scope: 'audit' })
    expect(w.reads.some((r) => ['usage_records', 'organization_invitations', 'notification_channels'].includes(r.table))).toBe(false)
  })
  it('reads big tables in pages and reports truncation when a cap is hit (newest first, nothing faked)', async () => {
    const big = Array.from({ length: EXPORT_TABLES.workflows.cap + 5 }, (_, i) => ({ id: `w${i}` }))
    const w = world('owner', {}, { workflows: big })
    const out = zipOf(await handleExport(w.d, { org_id: ORG }))
    expect(out.json('workflows.json')).toHaveLength(EXPORT_TABLES.workflows.cap)
    expect(out.json('manifest.json').truncated).toContain('workflows')
    expect(out.text('README.txt')).toMatch(/INCOMPLETE: workflows/)
    expect(w.reads.filter((r) => r.table === 'workflows').every((r) => r.limit <= PAGE_SIZE)).toBe(true)
    const exact = world('owner', {}, { workflows: big.slice(0, EXPORT_TABLES.workflows.cap) })
    expect(zipOf(await handleExport(exact.d, { org_id: ORG })).json('manifest.json').truncated).not.toContain('workflows') // exactly at the cap is not truncated
  })
})

describe('throttling and auditing', () => {
  it('refuses a second export within the window, saying how long to wait', async () => {
    const r = await handleExport(world('owner', { lastExportAt: async () => new Date(NOW.getTime() - 100_000) }).d, { org_id: ORG })
    expect(r).toMatchObject({ status: 429, body: { code: 'throttled', retry_after_seconds: THROTTLE_SECONDS - 100 } })
    expect((await handleExport(world('owner', { lastExportAt: async () => new Date(NOW.getTime() - (THROTTLE_SECONDS + 1) * 1000) }).d, { org_id: ORG })).status).toBe(200)
  })
  it('records the export in the audit log (counts only, never data) before returning', async () => {
    const w = world()
    await handleExport(w.d, { org_id: ORG })
    expect(w.audits).toHaveLength(1)
    expect(w.audits[0]).toMatchObject({ org_id: ORG, user_id: 'u1', action: 'org.exported', category: 'audit', status: 'success' })
    expect(JSON.stringify(w.audits)).not.toContain('Pay rent')
    expect(JSON.stringify(w.audits)).not.toContain('jane@acme.com')
  })
  it('a refused export writes nothing to the audit log and reads nothing', async () => {
    const w = world('member')
    await handleExport(w.d, { org_id: ORG })
    expect(w.audits).toHaveLength(0)
    expect(w.reads).toHaveLength(0)
  })
})

describe('CSV safety', () => {
  it.each([['=HYPERLINK("http://evil.test","x")', true], ['+1+1', true], ['-2+3', true], ['@SUM(A1)', true], ['\tcmd', true], ['normal text', false], ['a=b', false]])('%s', (v, escaped) => {
    const cell = csvCell(v)
    expect(cell.replace(/^"/, '').startsWith("'")).toBe(escaped)
  })
  it('quotes commas, quotes and newlines; renders objects as JSON; null as empty', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
    expect(csvCell(42)).toBe('42')
  })
  it('hostile audit text arrives defanged in the exported CSV', async () => {
    const w = world('admin', {}, { action_logs: [{ id: 'l1', action: 'email.send', status: 'failure', summary: '=cmd|\' /C calc\'!A0', error: '@evil', created_at: '2026-10-20T00:00:00Z' }] })
    const csv = zipOf(await handleExport(w.d, { org_id: ORG, scope: 'audit' })).text('action_logs.csv')
    const [header, row] = csv.trim().split('\r\n')
    expect(header.startsWith('created_at,actor_type,category,tool_name,action,status,summary,error')).toBe(true)
    expect(row).toContain("'=cmd")
    expect(row).toContain("'@evil")
    expect(row.split(',').some((c) => c.startsWith('=') || c.startsWith('@'))).toBe(false)
  })
  it('toCsv writes CRLF rows with a header', () => {
    expect(toCsv([{ a: 1, b: 'x' }], ['a', 'b'])).toBe('a,b\r\n1,x\r\n')
  })
})
