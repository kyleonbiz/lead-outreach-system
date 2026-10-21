import { describe, expect, it, vi } from 'vitest'
import { handleChannels, MAX_CHANNELS_PER_ORG, type ChannelDeps, type ChannelRow } from './notifyChannels.ts'
import { handleTick, type TickDeps } from './workflows.ts'
import { decryptSecret } from '../crypto.ts'
import type { Role } from './common.ts'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
const ORG = '11111111-1111-4111-8111-111111111111'
const ORG2 = '22222222-2222-4222-8222-222222222222'
const CH = '33333333-3333-4333-8333-333333333333'
const SLACK = ['https://hooks.slack.com', 'services', 'T0000', 'B0000', 'abcdefghijkl'].join('/') // runtime-built: no secret-shaped literal

function world(role: Role | null = 'admin', over: Partial<ChannelDeps> = {}) {
  const channels = new Map<string, ChannelRow>([[CH, { id: CH, org_id: ORG, kind: 'slack', name: 'Ops', enabled: true }]])
  const secrets = new Map<string, string>()
  const audits: Array<Record<string, unknown>> = []
  const tests: Array<[string, boolean, string | undefined]> = []
  const deps: ChannelDeps = {
    userId: 'u1', getRole: async (o) => (o === ORG ? role : null), encryptionKey: KEY, appUrl: 'https://app.example.com',
    fetch: vi.fn().mockResolvedValue(new Response('ok', { status: 200 })) as unknown as typeof fetch, newId: () => CH,
    loadChannel: async (id) => (role ? channels.get(id) ?? null : null),
    countChannels: async () => channels.size,
    insert: async (row, enc) => { channels.set(row.id, { id: row.id, org_id: row.org_id, kind: row.kind, name: row.name, enabled: true }); secrets.set(row.id, enc) },
    update: async (id, _o, _p, enc) => { if (enc) secrets.set(id, enc) },
    remove: async (id) => { channels.delete(id); secrets.delete(id) },
    encryptedUrl: async (id) => secrets.get(id) ?? null,
    recordTest: async (id, _o, ok, err) => { tests.push([id, ok, err]) },
    audit: async (e) => { audits.push(e as unknown as Record<string, unknown>) },
    ...over,
  }
  return { deps, channels, secrets, audits, tests }
}

describe('notification channels: create', () => {
  it('validates, encrypts the URL at rest and audits without leaking it', async () => {
    {
      const w = world(); w.channels.clear()
      const r = await handleChannels(w.deps, { action: 'create', org_id: ORG, kind: 'slack', name: ' Ops ', webhook_url: SLACK })
      expect(r.status).toBe(200)
      expect(r.body.url_hint).toBe('hooks.slack.com/…/ijkl')
      const stored = w.secrets.get(CH)!
      expect(stored).not.toContain('hooks.slack.com')
      expect(await decryptSecret(stored, KEY, `notify-channel:${CH}`)).toBe(SLACK) // round-trips
      await expect(decryptSecret(stored, KEY, 'notify-channel:other')).rejects.toThrow() // bound to this channel
      expect(JSON.stringify(w.audits)).not.toContain('abcdefghijkl')
      expect(JSON.stringify(r.body)).not.toContain('abcdefghijkl')
      expect(w.audits[0]).toMatchObject({ action: 'notification_channel.created', category: 'audit', user_id: 'u1' })
    }
  })
  it.each([
    ['plain http', 'http://hooks.slack.com/services/T/B/xxxx'],
    ['internal address', 'https://169.254.169.254/services/T/B/xxxx'],
    ['other host', 'https://evil.test/services/T/B/xxxx'],
    ['teams URL for a slack channel', 'https://contoso.webhook.office.com/webhookb2/a/b/c'],
  ])('refuses %s with 422 and stores nothing', async (_n, url) => {
    const w = world(); w.channels.clear()
    const r = await handleChannels(w.deps, { action: 'create', org_id: ORG, kind: 'slack', name: 'x', webhook_url: url })
    expect(r.status).toBe(422)
    expect(w.channels.size).toBe(0)
    expect(w.secrets.size).toBe(0)
    expect(JSON.stringify(r.body)).not.toContain('evil.test/services')
  })
  it('is admin-only, requires sign-in, needs the encryption key, and caps channels per organization', async () => {
    const body = { action: 'create', org_id: ORG, kind: 'slack', name: 'x', webhook_url: SLACK }
    expect((await handleChannels(world('member').deps, body)).status).toBe(403)
    expect((await handleChannels(world(null).deps, body)).status).toBe(403)
    expect((await handleChannels(world('admin', { userId: null }).deps, body)).status).toBe(401)
    expect(await handleChannels(world('admin', { encryptionKey: undefined }).deps, body)).toMatchObject({ status: 503, body: { missing: ['TOKEN_ENCRYPTION_KEY'] } })
    expect((await handleChannels(world('admin', { countChannels: async () => MAX_CHANNELS_PER_ORG }).deps, body)).status).toBe(409)
  })
  it('cannot create in an organization the caller does not belong to', async () => {
    const r = await handleChannels(world('owner').deps, { action: 'create', org_id: ORG2, kind: 'slack', name: 'x', webhook_url: SLACK })
    expect(r.status).toBe(403)
  })
  it('rejects malformed requests, unknown events and extra fields', async () => {
    const w = world().deps
    expect((await handleChannels(w, { action: 'create', org_id: ORG, kind: 'discord', name: 'x', webhook_url: SLACK })).status).toBe(400)
    expect((await handleChannels(w, { action: 'create', org_id: ORG, kind: 'slack', name: 'x', webhook_url: SLACK, events: ['everything'] })).status).toBe(400)
    expect((await handleChannels(w, { action: 'create', org_id: ORG, kind: 'slack', name: 'x', webhook_url: SLACK, events: [] })).status).toBe(400)
    expect((await handleChannels(w, { action: 'create', org_id: ORG, kind: 'slack', name: 'x', webhook_url: SLACK, org_id2: 'x' })).status).toBe(400)
    expect((await handleChannels(w, { action: 'nope' })).status).toBe(400)
    expect((await handleChannels(w, null)).status).toBe(400)
  })
})

describe('notification channels: update / delete / test', () => {
  it('replaces the URL only with a valid one for the channel kind, re-encrypts and audits', async () => {
    const w = world()
    const bad = await handleChannels(w.deps, { action: 'update', channel_id: CH, webhook_url: 'https://evil.test/x' })
    expect(bad.status).toBe(422)
    expect(w.secrets.size).toBe(0)
    const good = await handleChannels(w.deps, { action: 'update', channel_id: CH, webhook_url: SLACK, enabled: false })
    expect(good.status).toBe(200)
    expect(w.secrets.get(CH)).toBeTruthy()
    expect(w.audits[0]).toMatchObject({ action: 'notification_channel.updated', input: { changed: ['enabled', 'webhook_url'] } })
  })
  it('an update with nothing to change is a 400', async () => {
    expect((await handleChannels(world().deps, { action: 'update', channel_id: CH })).status).toBe(400)
  })
  it('hides channels from other organizations / non-admins (404 / 403) and never reveals them', async () => {
    const other = world(null) // RLS returns nothing for a caller who cannot see the channel
    expect((await handleChannels(other.deps, { action: 'delete', channel_id: CH })).status).toBe(404)
    expect((await handleChannels(world('member').deps, { action: 'delete', channel_id: CH })).status).toBe(403)
    expect((await handleChannels(world('member').deps, { action: 'test', channel_id: CH })).status).toBe(403)
  })
  it('deletes and audits', async () => {
    const w = world()
    expect((await handleChannels(w.deps, { action: 'delete', channel_id: CH })).status).toBe(200)
    expect(w.channels.size).toBe(0)
    expect(w.audits[0]).toMatchObject({ action: 'notification_channel.deleted' })
  })
  it('test sends a real message and reports success', async () => {
    const w = world()
    await handleChannels(w.deps, { action: 'update', channel_id: CH, webhook_url: SLACK })
    const r = await handleChannels(w.deps, { action: 'test', channel_id: CH })
    expect(r).toMatchObject({ status: 200, body: { sent: true } })
    expect(w.deps.fetch).toHaveBeenCalledTimes(1)
    expect(w.tests).toEqual([[CH, true, undefined]])
    expect(w.audits.at(-1)).toMatchObject({ action: 'notification_channel.tested', status: 'success' })
  })
  it('test reports the provider failure honestly (never a fake success) and records it', async () => {
    const w = world('admin', { fetch: vi.fn().mockResolvedValue(new Response('', { status: 404 })) as unknown as typeof fetch })
    await handleChannels(w.deps, { action: 'update', channel_id: CH, webhook_url: SLACK })
    const r = await handleChannels(w.deps, { action: 'test', channel_id: CH })
    expect(r.status).toBe(502)
    expect(String(r.body.error)).toContain('revoked')
    expect(w.tests[0][1]).toBe(false)
    expect(w.audits.at(-1)).toMatchObject({ status: 'failure' })
  })
  it('test with no stored URL, or an undecryptable one, says so instead of sending', async () => {
    const none = world()
    expect((await handleChannels(none.deps, { action: 'test', channel_id: CH })).status).toBe(409)
    const tampered = world(); tampered.secrets.set(CH, 'v1.AAAA.BBBB')
    expect((await handleChannels(tampered.deps, { action: 'test', channel_id: CH })).status).toBe(409)
    expect(tampered.deps.fetch).not.toHaveBeenCalled()
  })
})

describe('tick: notification work cannot break workflow processing', () => {
  const base = (over: Partial<TickDeps> = {}): TickDeps => ({
    authorized: true, now: () => new Date('2026-10-21T10:00:00Z'), listScheduled: async () => [], enqueue: async () => null,
    dispatchEvents: async () => 0, expireApprovals: async () => 0, processNow: async () => [], ...over,
  })
  it('runs overdue + dispatch after the workflow work and reports them', async () => {
    const order: string[] = []
    const r = await handleTick(base({
      processNow: async () => { order.push('process'); return [] },
      notifyOverdue: async () => { order.push('overdue'); return 3 },
      dispatchNotifications: async () => { order.push('dispatch'); return { claimed: 2, sent: 2, failed: 0, retried: 0, skipped: 0 } },
      pruneNotifications: async () => { order.push('prune'); return 1 },
    }))
    expect(order).toEqual(['process', 'overdue', 'dispatch', 'prune']) // minute 0 prunes
    expect(r.body.notifications).toMatchObject({ overdue_announced: 3, deliveries: { sent: 2 }, pruned: 1 })
  })
  it('prunes only on the hour', async () => {
    const prune = vi.fn().mockResolvedValue(0)
    await handleTick(base({ now: () => new Date('2026-10-21T10:07:00Z'), pruneNotifications: prune }))
    expect(prune).not.toHaveBeenCalled()
  })
  it('a failing notification step is reported and does not stop the others or the tick', async () => {
    const dispatch = vi.fn().mockResolvedValue({ claimed: 0, sent: 0, failed: 0, retried: 0, skipped: 0 })
    const r = await handleTick(base({ notifyOverdue: async () => { throw new Error('db down') }, dispatchNotifications: dispatch }))
    expect(r.status).toBe(200)
    expect(dispatch).toHaveBeenCalled()
    expect(r.body.notifications).toMatchObject({ overdue_announced_error: 'db down' })
  })
  it('still refuses unauthorized callers before doing anything', async () => {
    const dispatch = vi.fn()
    expect((await handleTick(base({ authorized: false, dispatchNotifications: dispatch }))).status).toBe(401)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
