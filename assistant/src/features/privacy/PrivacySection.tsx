import { useState } from 'react'
import { Download } from 'lucide-react'
import { Badge, Button, Dialog, Field, Input, Notice, Section, Select, Spinner } from '@/components/ui'
import { useAuth } from '@/features/auth/AuthProvider'
import { useOrg } from '@/features/org/OrgProvider'
import { FunctionError } from '@/features/assistant/api'
import { memberName, useMembers } from '@/features/team/api'
import { db } from '@/lib/supabase'
import { exportFilename, fetchExport, saveBlob, useDeleteAccount, useDeletionPreview, useTransferOwnership, type ExportScope } from './api'

const errText = (e: unknown) => (e instanceof FunctionError || e instanceof Error ? e.message : 'Something went wrong')

export function PrivacySection() {
  const { role } = useOrg()
  const [deleteOpen, setDeleteOpen] = useState(false)
  return (
    <Section title="Data & privacy">
      <div className="space-y-6 text-sm">
        {(role === 'owner' || role === 'admin') && <ExportData />}
        {role === 'owner' && <TransferOwnership />}
        <DeleteAccount onOpen={() => setDeleteOpen(true)} />
      </div>
      {/* the dialog lives outside the spaced stack: even closed (hidden) it would otherwise count as a sibling for space-y */}
      <DeleteDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} />
    </Section>
  )
}

function ExportData() {
  const { orgId, orgName, role } = useOrg()
  const [busy, setBusy] = useState<ExportScope | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)

  async function run(scope: ExportScope) {
    setBusy(scope); setMsg(null)
    try {
      saveBlob(await fetchExport(orgId, scope), exportFilename(orgName, scope))
      setMsg({ tone: 'ok', text: 'Your download has started. The export is recorded in Activity.' })
    } catch (e) { setMsg({ tone: 'danger', text: errText(e) }) } finally { setBusy(null) }
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="font-medium">Export your data</p>
        <p className="text-muted">
          A zip of readable files (JSON, and a CSV of the audit log). Documents are exported as details only, not the files themselves.
          Secrets such as connected-account credentials and webhook URLs are never included.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {role === 'owner' && (
          <Button onClick={() => run('all')} loading={busy === 'all'} disabled={busy !== null}><Download className="h-4 w-4" aria-hidden /> Download all organization data</Button>
        )}
        <Button onClick={() => run('audit')} loading={busy === 'audit'} disabled={busy !== null}><Download className="h-4 w-4" aria-hidden /> Download the audit log</Button>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  )
}

function TransferOwnership() {
  const { orgId } = useOrg()
  const { user } = useAuth()
  const members = useMembers(orgId)
  const transfer = useTransferOwnership(orgId)
  const [target, setTarget] = useState('')
  const [stepDown, setStepDown] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const others = (members.data ?? []).filter((m) => m.user_id !== user?.id)
  const chosen = others.find((m) => m.user_id === target)

  async function run() {
    setError(null); setDone(null)
    try {
      await transfer.mutateAsync({ newOwner: target, stepDown })
      setDone(`${memberName(chosen)} is now an owner${stepDown ? ' and you are an admin' : ' (you remain an owner too)'}.`)
      setConfirming(false); setTarget('')
    } catch (e) { setError(errText(e)); setConfirming(false) }
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="font-medium">Transfer ownership</p>
        <p className="text-muted">Make another team member an owner, and optionally step down. You need to do this before deleting your account if others depend on this organization.</p>
      </div>
      {others.length === 0 ? <p className="text-muted">There is nobody else on the team yet. Invite someone first.</p> : (
        <div className="space-y-3">
          <Field label="New owner">
            {(id) => (
              <Select id={id} value={target} onChange={(e) => { setTarget(e.target.value); setConfirming(false) }}>
                <option value="">Choose a team member…</option>
                {others.map((m) => <option key={m.user_id} value={m.user_id}>{memberName(m)} ({m.role})</option>)}
              </Select>
            )}
          </Field>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent))]" checked={stepDown} onChange={(e) => setStepDown(e.target.checked)} />
            Step down to admin after the transfer
          </label>
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>Make {memberName(chosen)} an owner{stepDown ? ' and step down' : ''}?</span>
              <Button variant="danger" onClick={run} loading={transfer.isPending}>Yes, transfer</Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            </div>
          ) : <Button onClick={() => setConfirming(true)} disabled={!target}>Transfer ownership…</Button>}
        </div>
      )}
      {done && <Notice tone="ok">{done}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  )
}

function DeleteAccount({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="space-y-3 rounded-lg border border-danger/40 p-4">
      <div>
        <p className="font-medium text-danger">Delete my account</p>
        <p className="text-muted">Permanently deletes your sign-in, your private assistant conversations and your preferences, and disconnects the accounts you connected. This cannot be undone.</p>
      </div>
      <Button variant="danger" onClick={onOpen}>Delete my account…</Button>
    </div>
  )
}

function DeleteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { signOut } = useAuth()
  const preview = useDeletionPreview(open)
  const del = useDeleteAccount()
  const [email, setEmail] = useState('')
  const [acknowledged, setAcknowledged] = useState<string[]>([])
  const [error, setError] = useState<{ text: string; code?: string } | null>(null)
  const [finished, setFinished] = useState(false)

  const p = preview.data
  const blocked = p?.organizations.filter((o) => o.plan === 'blocked') ?? []
  const toDelete = p?.organizations.filter((o) => o.plan === 'delete_org') ?? []
  const leaving = p?.organizations.filter((o) => o.plan === 'leave') ?? []
  const allAcknowledged = toDelete.every((o) => acknowledged.includes(o.id))
  const typedOk = !!p?.email && email.trim().toLowerCase() === p.email.toLowerCase()
  const ready = !!p && p.can_delete && p.recent_sign_in && typedOk && allAcknowledged

  async function submit() {
    setError(null)
    try {
      await del.mutateAsync({ confirm_email: email.trim(), delete_org_ids: toDelete.map((o) => o.id) })
      setFinished(true)
      await db().auth.signOut().catch(() => {})
    } catch (e) { setError({ text: errText(e), code: e instanceof FunctionError ? String(e.body.code ?? '') : undefined }) }
  }

  return (
    <Dialog
      open={open} onClose={finished ? () => window.location.assign('/') : onClose} title={finished ? 'Your account was deleted' : 'Delete your account'}
      footer={finished ? <Button variant="primary" onClick={() => window.location.assign('/')}>Done</Button> : (
        <><Button onClick={onClose} disabled={del.isPending}>Cancel</Button><Button variant="danger" onClick={submit} loading={del.isPending} disabled={!ready}>Permanently delete my account</Button></>
      )}
    >
      {finished ? (
        <p className="text-sm">Your account and personal data were deleted and you were signed out. Thank you for using Aide.</p>
      ) : (
        <div className="space-y-4 text-sm">
          {preview.isLoading && <Spinner label="Checking what this will delete" />}
          {preview.isError && <Notice tone="danger">{errText(preview.error)}</Notice>}
          {p && (
            <>
              {!p.recent_sign_in && (
                <Notice tone="warn" title="Sign in again first">
                  For your security you must have signed in within the last {p.recent_sign_in_minutes} minutes.
                  <div className="mt-2"><Button onClick={() => void signOut()}>Sign out, then sign in again</Button></div>
                </Notice>
              )}
              {blocked.length > 0 && (
                <Notice tone="danger" title="Transfer ownership first">
                  You are the only owner of {blocked.map((o) => <strong key={o.id}>{o.name} </strong>)}, which still has other members. Make someone else an owner (Settings → Data & privacy → Transfer ownership), then come back.
                </Notice>
              )}
              {toDelete.length > 0 && (
                <fieldset className="space-y-2 rounded-lg border border-danger/40 p-3">
                  <legend className="px-1 font-medium text-danger">These organizations will be permanently deleted with you</legend>
                  {toDelete.map((o) => (
                    <label key={o.id} className="flex items-start gap-2">
                      <input
                        type="checkbox" className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]" checked={acknowledged.includes(o.id)}
                        onChange={(e) => setAcknowledged((cur) => (e.target.checked ? [...cur, o.id] : cur.filter((x) => x !== o.id)))}
                      />
                      <span>Delete <strong>{o.name}</strong> and all of its tasks, documents and history. You are its only member.</span>
                    </label>
                  ))}
                </fieldset>
              )}
              {leaving.length > 0 && (
                <p className="text-muted">You will leave {leaving.map((o, i) => <span key={o.id}>{i > 0 ? ', ' : ''}<strong className="text-ink">{o.name}</strong></span>)}. Their data stays with the people who remain; your tasks and uploads stay but are no longer linked to you.</p>
              )}
              <ul className="list-disc space-y-1 pl-5 text-muted">
                <li>Accounts you connected (such as Gmail or Outlook) are disconnected. Google can be revoked automatically; for Microsoft you should also remove the app in your Microsoft account settings.</li>
                <li>Your e-mail address is removed from audit-log entries you created.</li>
              </ul>
              <Field label={`Type ${p.email ?? 'your e-mail address'} to confirm`}>
                {(id) => <Input id={id} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" spellCheck={false} />}
              </Field>
            </>
          )}
          {error && (
            <Notice tone="danger" title={error.code === 'incomplete' ? 'Not everything was deleted' : "We couldn't delete your account"}>{error.text}</Notice>
          )}
          {p && <div className="flex gap-2"><Badge tone={ready ? 'danger' : 'neutral'}>{ready ? 'Ready: this cannot be undone' : 'Complete the steps above'}</Badge></div>}
        </div>
      )}
    </Dialog>
  )
}
