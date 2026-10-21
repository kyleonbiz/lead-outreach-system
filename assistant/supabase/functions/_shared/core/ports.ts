// Ports: the narrow interfaces tools depend on. Real implementations (Supabase / Google) live in
// supabase/functions/_shared/adapters; tests use in-memory fakes.

export interface TaskRecord {
  id: string; title: string; description: string | null; status: string; priority: string
  category: string | null; due_at: string | null; recurrence: string | null; completed_at: string | null
}
export interface TaskFilter {
  status?: string[]; overdue?: boolean; due_before?: string; category?: string; limit: number
}
export interface TaskInput {
  title?: string; description?: string | null; due_at?: string | null; priority?: string
  category?: string | null; recurrence?: string | null; status?: string; notes?: string | null
}

export interface TaskPort {
  list(f: TaskFilter): Promise<TaskRecord[]>
  create(input: TaskInput & { title: string }): Promise<TaskRecord>
  update(id: string, patch: TaskInput): Promise<TaskRecord | null>
  /** completes the task; a recurring task spawns its next occurrence (returned as nextId) */
  complete(id: string): Promise<{ completed: boolean; nextId: string | null }>
  remove(id: string): Promise<boolean>
}

export interface KnowledgeHit { source: 'knowledge' | 'document'; id: string; title: string; snippet: string }
export interface KnowledgePort {
  search(query: string, limit: number): Promise<KnowledgeHit[]>
}

export interface EmailMessageSummary {
  id: string; threadId: string; from: string; to: string[]; subject: string; snippet: string
  date: string; unread: boolean; labels: string[]
}
export interface EmailThread {
  id: string
  messages: Array<{ id: string; from: string; to: string[]; cc: string[]; subject: string; date: string; body: string }>
}
export interface OutgoingEmail {
  to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; inReplyToThreadId?: string
}
/** Provider-neutral email contract. Gmail implements it today; Outlook can implement it later. */
export interface EmailProvider {
  readonly provider: string
  accountEmail(): string
  search(query: string, limit: number): Promise<EmailMessageSummary[]>
  getThread(threadId: string): Promise<EmailThread>
  createDraft(m: OutgoingEmail): Promise<{ draftId: string }>
  send(m: OutgoingEmail): Promise<{ messageId: string }>
}

export interface CalendarEvent {
  id: string; title: string; start: string; end: string; allDay: boolean; attendees: string[]
  location?: string; description?: string; htmlLink?: string
}
export interface NewCalendarEvent {
  title: string; start: string; end: string; timeZone: string; attendees: string[]
  description?: string; location?: string
}
export interface CalendarProvider {
  readonly provider: string
  listEvents(timeMin: string, timeMax: string, limit: number): Promise<CalendarEvent[]>
  freeBusy(timeMin: string, timeMax: string): Promise<Array<{ start: string; end: string }>>
  createEvent(e: NewCalendarEvent): Promise<CalendarEvent>
  updateEvent(id: string, patch: Partial<NewCalendarEvent>): Promise<CalendarEvent>
}

export interface DocumentRecord { id: string; name: string; category: string | null; summary: string | null; status: string; created_at: string }
export interface DocumentDetail extends DocumentRecord { extracted: unknown; text: string }
export interface DocumentPort {
  list(limit: number): Promise<DocumentRecord[]>
  get(id: string, maxChars: number): Promise<DocumentDetail>
  /** creates a generated document (markdown) in storage + the documents table */
  createGenerated(input: { title: string; markdown: string; category?: string }): Promise<DocumentRecord>
}

/** Email/calendar are resolved lazily and throw NotConfiguredError when the account isn't connected. */
export interface Ports {
  tasks: TaskPort
  knowledge: KnowledgePort
  documents: DocumentPort
  email(): Promise<EmailProvider>
  calendar(): Promise<CalendarProvider>
  /** organization-configured urgent-mail rules (raw JSON; parsed with parseRules) */
  emailRules?(): Promise<unknown>
}
