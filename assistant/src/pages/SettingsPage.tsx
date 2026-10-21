import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Field, Input, Notice, PageHeader, Section } from '@/components/ui'
import { db } from '@/lib/supabase'
import { useOrg } from '@/features/org/OrgProvider'
import { useAuth } from '@/features/auth/AuthProvider'
import { TeamSection } from '@/features/team/TeamSection'
import { ApprovalRulesSection } from '@/features/approvals/ApprovalRulesSection'
import { NotificationSettings } from '@/features/notifications/NotificationSettings'

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

        <TeamSection />

        <EmailRulesSection />

        <ApprovalRulesSection />

        <NotificationSettings />

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

function EmailRulesSection() {
  const { orgId, isAdmin } = useOrg()
  const qc = useQueryClient()
  const rules = useQuery({
    queryKey: ['email-rules', orgId],
    queryFn: async () => {
      const { data, error } = await db().from('organization_settings').select('email_rules').eq('org_id', orgId).maybeSingle()
      if (error) throw error
      return (data?.email_rules ?? {}) as { urgent_keywords?: string[]; vip_senders?: string[]; ignore_senders?: string[] }
    },
  })
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const save = useMutation({
    mutationFn: async (v: { urgent_keywords: string[]; vip_senders: string[]; ignore_senders: string[] }) => {
      const { error } = await db().from('organization_settings').update({ email_rules: v }).eq('org_id', orgId)
      if (error) throw error
    },
    onSuccess: () => { setMsg({ tone: 'ok', text: 'Saved.' }); qc.invalidateQueries({ queryKey: ['email-rules'] }); qc.invalidateQueries({ queryKey: ['email-triage'] }) },
    onError: (e: Error) => setMsg({ tone: 'danger', text: e.message }),
  })
  const list = (v: FormDataEntryValue | null) => String(v ?? '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean)
  const show = (a?: string[]) => (a ?? []).join(', ')

  return (
    <Section title="Email rules">
      <form key={JSON.stringify(rules.data)} className="space-y-4" onSubmit={(e) => {
        e.preventDefault(); const f = new FormData(e.currentTarget); setMsg(null)
        save.mutate({ urgent_keywords: list(f.get('kw')), vip_senders: list(f.get('vip')), ignore_senders: list(f.get('ign')) })
      }}>
        <p className="text-sm text-muted">Decide what counts as urgent. Separate entries with commas. Senders can be an address or a whole domain like <code className="font-mono">@bigclient.com</code>.</p>
        <Field label="Urgent keywords" hint="Added to built-ins like “urgent”, “overdue”, “deadline”.">
          {(id) => <Input id={id} name="kw" disabled={!isAdmin} defaultValue={show(rules.data?.urgent_keywords)} />}
        </Field>
        <Field label="VIP senders">{(id) => <Input id={id} name="vip" disabled={!isAdmin} defaultValue={show(rules.data?.vip_senders)} />}</Field>
        <Field label="Ignore senders">{(id) => <Input id={id} name="ign" disabled={!isAdmin} defaultValue={show(rules.data?.ignore_senders)} />}</Field>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <Button type="submit" variant="primary" disabled={!isAdmin} loading={save.isPending}>Save rules</Button>
      </form>
    </Section>
  )
}
