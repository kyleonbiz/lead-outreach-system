import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useLocation } from 'react-router-dom'
import { Plus, Send, Wrench } from 'lucide-react'
import { Button, Notice, PageHeader, Spinner, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useOrg } from '@/features/org/OrgProvider'
import { FunctionError, useConversations, useMessages, usePendingApprovalList, useSendMessage } from '@/features/assistant/api'
import { ApprovalCard } from '@/features/assistant/ApprovalCard'

export default function AssistantPage() {
  const { orgId } = useOrg()
  const location = useLocation()
  const conversations = useConversations(orgId)
  const approvals = usePendingApprovalList(orgId)
  const send = useSendMessage(orgId)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState((location.state as { prompt?: string } | null)?.prompt ?? '')
  const [optimistic, setOptimistic] = useState<string | null>(null)
  const messages = useMessages(activeId)
  const bottom = useRef<HTMLDivElement>(null)

  const visible = useMemo(
    () => (messages.data ?? []).filter((m) => m.role === 'user' || (m.role === 'assistant' && (m.content || m.tool_calls?.length))),
    [messages.data],
  )
  const convApprovals = (approvals.data ?? []).filter((a) => a.conversation_id === activeId || (!activeId && false))
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [visible.length, send.isPending, convApprovals.length])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const message = draft.trim()
    if (!message || send.isPending) return
    setOptimistic(message); setDraft('')
    try {
      const r = await send.mutateAsync({ conversationId: activeId, message })
      setActiveId(r.conversation_id)
    } catch { setDraft(message) } finally { setOptimistic(null) }
  }

  const err = send.error as FunctionError | null
  const notConfigured = err instanceof FunctionError && err.body.code === 'not_configured'

  return (
    <>
      <PageHeader title="Assistant" description="Tell it what you need. It acts through your connected tools and asks before anything consequential." />
      <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
        <aside className="min-w-0">
          <Button className="mb-2 w-full" onClick={() => { setActiveId(null); send.reset() }}><Plus className="h-4 w-4" /> New conversation</Button>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto lg:max-h-[60vh]">
            {(conversations.data ?? []).map((c) => (
              <li key={c.id}>
                <button onClick={() => setActiveId(c.id)} className={cn('w-full truncate rounded px-3 py-2 text-left text-sm',
                  c.id === activeId ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-sunken hover:text-ink')}>
                  {c.title || 'Untitled'}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="flex min-h-[60vh] min-w-0 flex-col rounded-lg border border-line bg-surface">
          <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
            {!activeId && !optimistic && (
              <p className="py-10 text-center text-sm text-muted">
                Try: "Create a task to call the accountant on Friday at 10am" or "What tasks are overdue?"
              </p>
            )}
            {messages.isLoading && activeId && <Spinner />}
            {visible.map((m) => (
              <div key={m.id} className={cn('flex', m.role === 'user' && 'justify-end')}>
                <div className={cn('max-w-[85%] whitespace-pre-wrap wrap-break-word rounded-lg px-3.5 py-2.5 text-sm',
                  m.role === 'user' ? 'bg-accent text-accent-ink' : 'bg-sunken', m.metadata?.error ? 'text-danger' : '')}>
                  {m.content}
                  {m.tool_calls?.filter((t) => t.type === 'tool_use').map((t, i) => (
                    <span key={i} className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                      <Wrench className="h-3 w-3" aria-hidden /> Used {String(t.name).replace('__', '.')}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {optimistic && (
              <div className="flex justify-end"><div className="max-w-[85%] rounded-lg bg-accent px-3.5 py-2.5 text-sm text-accent-ink">{optimistic}</div></div>
            )}
            {send.isPending && <Spinner label="Working on it" />}
            {convApprovals.map((a) => <ApprovalCard key={a.id} a={a} />)}
            <div ref={bottom} />
          </div>

          <div className="border-t border-line p-3">
            {notConfigured && (
              <div className="mb-3">
                <Notice tone="warn" title="The assistant needs setup">
                  The server is missing: <code className="font-mono">{(err!.body.missing as string[]).join(', ')}</code>. See docs/SETUP.md.
                </Notice>
              </div>
            )}
            {err && !notConfigured && <div className="mb-3"><Notice tone="danger">{err.message}</Notice></div>}
            <form onSubmit={onSubmit} className="flex items-end gap-2">
              <label htmlFor="msg" className="sr-only">Message</label>
              <Textarea id="msg" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={8000} className="resize-none"
                placeholder="Ask your assistant…"
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }} />
              <Button type="submit" variant="primary" disabled={!draft.trim() || send.isPending} aria-label="Send"><Send className="h-4 w-4" /></Button>
            </form>
          </div>
        </section>
      </div>
    </>
  )
}
