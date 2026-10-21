import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { Badge, Button, Input, Notice, Section } from '@/components/ui'
import { db } from '@/lib/supabase'
import { useOrg } from '@/features/org/OrgProvider'
import { ApprovalPolicy, entryProblem, validatePolicyInput } from '@core/policy.ts'

interface Draft { email: { on: boolean; items: string[] }; calendar: { on: boolean; items: string[] } }

const ALWAYS_ASK = ['Deleting anything', 'Payments', 'Signing agreements', 'Changing critical settings']

function toDraft(raw: unknown): { draft: Draft; stored: boolean } {
  const parsed = ApprovalPolicy.safeParse(raw)
  const rules = parsed.success ? parsed.data.auto_approve : []
  const email = rules.find((r) => r.action === 'email.send')
  const cal = rules.find((r) => r.action === 'calendar.create_event')
  return {
    stored: parsed.success,
    draft: {
      email: { on: !!email, items: email?.action === 'email.send' ? email.allowed_recipients : [] },
      calendar: { on: !!cal, items: cal?.action === 'calendar.create_event' ? cal.internal_domains : [] },
    },
  }
}

function toPolicy(d: Draft) {
  return {
    auto_approve: [
      ...(d.email.on ? [{ action: 'email.send', allowed_recipients: d.email.items }] : []),
      ...(d.calendar.on ? [{ action: 'calendar.create_event', internal_domains: d.calendar.items }] : []),
    ],
  }
}

export function ApprovalRulesSection() {
  const { orgId, isAdmin, settings, refresh } = useOrg()
  const initial = useMemo(() => toDraft(settings?.approval_policy), [settings?.approval_policy])
  const [draft, setDraft] = useState<Draft>(initial.draft)
  const [baseline, setBaseline] = useState(JSON.stringify(initial.draft))
  const [errors, setErrors] = useState<string[]>([])
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  // pick up changes saved elsewhere (another tab, another admin)
  const [seen, setSeen] = useState(settings?.approval_policy)
  if (settings?.approval_policy !== seen) {
    setSeen(settings?.approval_policy); setDraft(initial.draft); setBaseline(JSON.stringify(initial.draft))
  }

  const dirty = JSON.stringify(draft) !== baseline
  const set = (k: keyof Draft, v: Draft[keyof Draft]) => { setDraft((d) => ({ ...d, [k]: v })); setSaved(false); setErrors([]) }

  async function save() {
    const check = validatePolicyInput(toPolicy(draft))
    if (!check.ok) { setErrors(check.errors); return }
    setBusy(true); setErrors([]); setSaved(false)
    const { error } = await db().rpc('set_approval_policy', { p_org: orgId, p_policy: check.policy })
    setBusy(false)
    if (error) { setErrors([error.message]); return }
    await refresh()
    setBaseline(JSON.stringify(draft)); setSaved(true)
  }

  return (
    <Section title="Approvals & automatic permissions">
      <div className="space-y-5 text-sm">
        <p>
          By default the assistant asks you before it does anything sensitive. You can let it skip the question for
          <strong> very specific</strong> cases below. Every change is recorded in Activity.
        </p>

        {!initial.stored && (
          <Notice tone="warn" title="Saved rules are being ignored">
            The stored rules are not valid, so the assistant is asking about everything. Save new rules to fix this.
          </Notice>
        )}

        <RuleEditor
          title="Send email without asking"
          help="Only when every recipient (To, Cc and Bcc) is on this list. Use an exact address like jane@acme.com, or a company domain like @acme.com."
          kind="recipient" placeholder="jane@acme.com or @acme.com"
          rule={draft.email} disabled={!isAdmin} onChange={(v) => set('email', v)}
        />
        <RuleEditor
          title="Create calendar events without asking"
          help="Only when every attendee is at one of these domains (or there are no attendees)."
          kind="domain" placeholder="acme.com"
          rule={draft.calendar} disabled={!isAdmin} onChange={(v) => set('calendar', v)}
        />

        <div>
          <p className="font-medium">Always asks, and can't be turned off</p>
          <ul className="mt-2 flex flex-wrap gap-2">{ALWAYS_ASK.map((a) => <li key={a}><Badge>{a}</Badge></li>)}</ul>
        </div>

        {errors.length > 0 && (
          <Notice tone="danger" title="These rules can't be saved">
            <ul className="list-disc pl-4">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
          </Notice>
        )}
        {saved && <Notice tone="ok">Saved. The change is recorded in Activity.</Notice>}

        {isAdmin
          ? <Button variant="primary" onClick={save} loading={busy} disabled={!dirty}>Save approval rules</Button>
          : <p className="text-muted">Only owners and admins can change these rules.</p>}
      </div>
    </Section>
  )
}

function RuleEditor({
  title, help, kind, placeholder, rule, disabled, onChange,
}: {
  title: string; help: string; kind: 'recipient' | 'domain'; placeholder: string
  rule: { on: boolean; items: string[] }; disabled: boolean; onChange: (v: { on: boolean; items: string[] }) => void
}) {
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  function add() {
    const entry = text.trim().toLowerCase()
    if (!entry) return
    const p = entryProblem(entry, kind)
    if (p) { setProblem(`"${entry}" ${p}`); return }
    const canonical = kind === 'domain' && !entry.startsWith('@') ? `@${entry}` : entry
    setProblem(null); setText('')
    if (!rule.items.includes(canonical)) onChange({ ...rule, items: [...rule.items, canonical] })
  }

  return (
    <fieldset className="space-y-2 rounded-lg border border-line p-4" disabled={disabled}>
      <legend className="px-1 font-medium">
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox" checked={rule.on} disabled={disabled} onChange={(e) => onChange({ ...rule, on: e.target.checked })}
            className="h-4 w-4 accent-[rgb(var(--accent))]"
          />
          {title}
        </label>
      </legend>
      <p className="text-muted">{help}</p>
      {rule.on && (
        <>
          {rule.items.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label={`${title}: allowed`}>
              {rule.items.map((it) => (
                <li key={it} className="inline-flex items-center gap-1 rounded-full bg-sunken py-1 pl-3 pr-1 text-xs">
                  {it}
                  <button
                    type="button" aria-label={`Remove ${it}`} className="rounded-full p-1 text-muted hover:bg-line hover:text-ink"
                    onClick={() => onChange({ ...rule, items: rule.items.filter((x) => x !== it) })}
                  ><X className="h-3 w-3" aria-hidden /></button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Input
              aria-label={`Add to: ${title}`} value={text} placeholder={placeholder}
              onChange={(e) => { setText(e.target.value); setProblem(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
            />
            <Button type="button" onClick={add}>Add</Button>
          </div>
          {problem && <p role="alert" className="text-xs text-danger">{problem}</p>}
          {rule.items.length === 0 && <p className="text-xs text-warn">Add at least one entry, or this rule can't be saved.</p>}
        </>
      )}
    </fieldset>
  )
}
