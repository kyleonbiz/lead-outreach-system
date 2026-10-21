import { useState, type FormEvent } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { Copy } from 'lucide-react'
import { Badge, Button, Field, Input, Notice, Section, Select, Spinner } from '@/components/ui'
import { useAuth } from '@/features/auth/AuthProvider'
import { useOrg } from '@/features/org/OrgProvider'
import type { Role } from '@/lib/types'
import {
  memberName, useChangeRole, useInvitations, useInvite, useMembers, useRemoveMember, useRevokeInvitation, type InviteResult, type Member,
} from './api'

const ROLE_HELP: Record<Role, string> = {
  owner: 'Full control, including people and billing-level settings',
  admin: 'Manages settings, integrations, workflows and rules',
  member: 'Works with tasks, documents and the assistant',
}

export function TeamSection() {
  const { orgId, role } = useOrg()
  const { user } = useAuth()
  const members = useMembers(orgId)
  const isOwner = role === 'owner'

  return (
    <Section title="Team">
      <div className="space-y-5 text-sm">
        {members.isLoading && <Spinner />}
        {members.isError && <Notice tone="danger" title="Couldn't load the team">{(members.error as Error).message}</Notice>}
        {members.data && (
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Team members">
            {members.data.map((m) => <MemberRow key={m.user_id} m={m} me={m.user_id === user?.id} isOwner={isOwner} />)}
          </ul>
        )}
        {isOwner && <InviteForm />}
        {isOwner && <PendingInvitations />}
        {!isOwner && <p className="text-muted">Only owners can invite people or change roles.</p>}
      </div>
    </Section>
  )
}

function MemberRow({ m, me, isOwner }: { m: Member; me: boolean; isOwner: boolean }) {
  const { orgId } = useOrg()
  const change = useChangeRole(orgId)
  const remove = useRemoveMember(orgId)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = me ? 'leave' : 'remove'

  async function run(fn: () => Promise<unknown>) {
    setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) }
  }

  return (
    <li className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{memberName(m)}</span>
        {me && <Badge tone="accent">You</Badge>}
        {m.email && <span className="text-xs text-muted">{m.email}</span>}
        <span className="ml-auto flex items-center gap-2">
          {isOwner ? (
            <Select
              aria-label={`Role for ${memberName(m)}`} value={m.role} className="w-28" disabled={change.isPending}
              onChange={(e) => void run(() => change.mutateAsync({ userId: m.user_id, role: e.target.value as Role }))}
            >
              <option value="owner">Owner</option><option value="admin">Admin</option><option value="member">Member</option>
            </Select>
          ) : <Badge>{m.role}</Badge>}
        </span>
      </div>
      <p className="text-xs text-muted">{ROLE_HELP[m.role]}</p>
      {(isOwner || me) && (
        <div className="flex flex-wrap gap-2">
          {confirming ? (
            <>
              <Button variant="danger" loading={remove.isPending} onClick={() => void run(async () => { await remove.mutateAsync(m.user_id); setConfirming(false) })}>
                Confirm {label}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirming(true)} aria-label={`${me ? 'Leave' : 'Remove'} ${memberName(m)}`}>
              {me ? 'Leave organization' : 'Remove'}
            </Button>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </li>
  )
}

function InviteForm() {
  const { orgId } = useOrg()
  const invite = useInvite(orgId)
  const [result, setResult] = useState<(InviteResult & { email: string }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const f = new FormData(form)
    const email = String(f.get('email') ?? '').trim()
    setError(null); setResult(null); setCopied(false)
    try {
      const r = await invite.mutateAsync({ email, role: String(f.get('role')) as 'admin' | 'member' })
      setResult({ ...r, email })
      form.reset()
    } catch (err) { setError((err as Error).message) }
  }

  async function copy(link: string) {
    try { await navigator.clipboard.writeText(link); setCopied(true) } catch { setCopied(false) }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-line p-4" aria-label="Invite someone">
      <p className="font-medium">Invite someone</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
        <Field label="E-mail address">{(id) => <Input id={id} name="email" type="email" required maxLength={254} autoComplete="off" />}</Field>
        <Field label="Role">
          {(id) => <Select id={id} name="role" defaultValue="member"><option value="member">Member</option><option value="admin">Admin</option></Select>}
        </Field>
        <Button type="submit" variant="primary" loading={invite.isPending}>Send invitation</Button>
      </div>
      <p className="text-xs text-muted">The link works once, only for that address, and expires in 7 days. Owners can only be added by promoting an existing member.</p>
      {error && <Notice tone="danger">{error}</Notice>}
      {result?.emailed && <Notice tone="ok">Invitation e-mailed to {result.email}.</Notice>}
      {result && !result.emailed && (
        <Notice tone="warn" title="The e-mail was not sent">
          <p>{result.reason}</p>
          {result.link && (
            <div className="mt-2 space-y-2">
              <p>Send this link to {result.email} yourself. It is shown only now and works only for that address.</p>
              <div className="flex gap-2">
                <Input readOnly aria-label="Invitation link" value={result.link} onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" onClick={() => void copy(result.link!)}><Copy className="h-4 w-4" aria-hidden /> {copied ? 'Copied' : 'Copy'}</Button>
              </div>
            </div>
          )}
        </Notice>
      )}
    </form>
  )
}

function PendingInvitations() {
  const { orgId } = useOrg()
  const q = useInvitations(orgId, true)
  const revoke = useRevokeInvitation(orgId)
  const [error, setError] = useState<string | null>(null)
  if (!q.data?.length) return null
  return (
    <div className="space-y-2">
      <p className="font-medium">Waiting to join</p>
      <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Pending invitations">
        {q.data.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-2 p-3">
            <span>{i.email}</span>
            <Badge>{i.role}</Badge>
            <span className="text-xs text-muted">expires in {formatDistanceToNowStrict(new Date(i.expires_at))}</span>
            <Button
              variant="ghost" className="ml-auto" aria-label={`Revoke invitation for ${i.email}`} loading={revoke.isPending && revoke.variables === i.id}
              onClick={async () => { setError(null); try { await revoke.mutateAsync(i.id) } catch (e) { setError((e as Error).message) } }}
            >Revoke</Button>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  )
}
