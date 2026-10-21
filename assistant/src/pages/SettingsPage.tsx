import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Badge, Button, Field, Input, Notice, PageHeader, Section } from '@/components/ui'
import { db } from '@/lib/supabase'
import { useOrg } from '@/features/org/OrgProvider'
import { useAuth } from '@/features/auth/AuthProvider'

export default function SettingsPage() {
  const { orgId, orgName, role, isAdmin, settings, profile, refresh } = useOrg()
  const { user } = useAuth()
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)

  const save = useMutation({
    mutationFn: async (v: { name: string; timezone: string; fullName: string }) => {
      const p = await db().from('profiles').update({ full_name: v.fullName || null }).eq('id', user!.id)
      if (p.error) throw p.error
      if (isAdmin) {
        const o = await db().from('organizations').update({ name: v.name }).eq('id', orgId)
        if (o.error) throw o.error
        const s = await db().from('organization_settings').update({ timezone: v.timezone }).eq('org_id', orgId)
        if (s.error) throw s.error
      }
    },
    onSuccess: async () => { await refresh(); setMsg({ tone: 'ok', text: 'Saved.' }) },
    onError: (e: Error) => setMsg({ tone: 'danger', text: e.message }),
  })

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const timezone = String(f.get('timezone') ?? '').trim() || 'UTC'
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }) } catch {
      setMsg({ tone: 'danger', text: `"${timezone}" is not a valid time zone (try e.g. America/Chicago).` }); return
    }
    setMsg(null)
    save.mutate({ name: String(f.get('name') ?? '').trim() || orgName, timezone, fullName: String(f.get('fullName') ?? '').trim() })
  }

  return (
    <>
      <PageHeader title="Settings" />
      <div className="max-w-2xl space-y-6">
        <form onSubmit={onSubmit} className="space-y-6" key={`${orgName}-${settings?.timezone}-${profile?.full_name}`}>
          <Section title="Profile & business">
            <div className="space-y-4">
              <Field label="Your name">{(id) => <Input id={id} name="fullName" maxLength={200} defaultValue={profile?.full_name ?? ''} />}</Field>
              <Field label="Business name" hint={isAdmin ? undefined : 'Only admins can change this.'}>
                {(id) => <Input id={id} name="name" required maxLength={120} defaultValue={orgName} disabled={!isAdmin} />}
              </Field>
              <Field label="Time zone" hint="Used for agendas, reminders and scheduling.">
                {(id) => <Input id={id} name="timezone" defaultValue={settings?.timezone ?? 'UTC'} disabled={!isAdmin} />}
              </Field>
              {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
              <Button type="submit" variant="primary" loading={save.isPending}>Save changes</Button>
            </div>
          </Section>
        </form>

        <Section title="Approvals & permissions">
          <div className="space-y-2 text-sm">
            <p>
              The assistant asks for your approval before it sends external email, deletes anything, spends money,
              signs agreements or changes critical settings.
            </p>
            <p className="text-muted">
              Automatic approvals configured: <strong className="text-ink">{settings?.approval_policy.auto_approve.length ?? 0}</strong>.
              Narrow, per-action pre-approvals can be added once the assistant is live (Phase 3).
            </p>
          </div>
        </Section>

        <Section title="Account">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted">Email</dt><dd>{user?.email}</dd>
            <dt className="text-muted">Your role</dt><dd><Badge tone="accent">{role}</Badge></dd>
          </dl>
        </Section>
      </div>
    </>
  )
}
