// Row shapes for the tables the UI reads. Keep in sync with supabase/migrations.
// (Replace with `supabase gen types typescript` output once a project exists.)

export type Role = 'owner' | 'admin' | 'member'
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'
export type Recurrence = 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly'

export interface Organization {
  id: string
  name: string
}

export interface Membership {
  org_id: string
  role: Role
  organizations: Organization
}

export interface OrgSettings {
  org_id: string
  timezone: string
  ai_model: string | null
  approval_policy: { auto_approve: unknown[] }
  briefing_enabled: boolean
}

export interface Task {
  id: string
  org_id: string
  title: string
  description: string | null
  notes: string | null
  status: TaskStatus
  priority: TaskPriority
  category: string | null
  due_at: string | null
  recurrence: Recurrence | null
  assignee_id: string | null
  created_via: 'user' | 'assistant' | 'workflow'
  completed_at: string | null
  created_at: string
}

export interface ActionLog {
  id: string
  org_id: string
  actor_type: 'user' | 'assistant' | 'workflow' | 'system'
  category: 'tool_call' | 'audit' | 'integration' | 'error'
  tool_name: string | null
  action: string
  status: 'success' | 'failure' | 'pending' | 'denied'
  summary: string | null
  error: string | null
  duration_ms: number | null
  created_at: string
}

export interface ApprovalRequest {
  id: string
  org_id: string
  action_type: string
  summary: string
  risk: 'low' | 'medium' | 'high'
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'failed'
  created_at: string
}

export interface ConnectedIntegration {
  id: string
  provider: 'google_gmail' | 'google_calendar' | 'microsoft_mail' | 'microsoft_calendar'
  status: 'connected' | 'needs_reauth' | 'revoked' | 'error'
  external_account: string
  last_error: string | null
  last_synced_at: string | null
}
