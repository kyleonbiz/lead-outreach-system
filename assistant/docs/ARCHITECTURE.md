# Architecture & security model

## Shape
```
Browser (React SPA, anon key)  ──RLS──▶  Supabase Postgres  ◀── service role ── Edge Functions / worker
        │                                      ▲                    (AI calls, OAuth tokens, tools, jobs)
        └── Supabase Auth (JWT) ───────────────┘
```
* The browser only holds the anon key + the user's JWT. Everything it can read or write is decided
  by Postgres Row Level Security and column grants, not by frontend filtering.
* Privileged work (calling Anthropic, using OAuth tokens, executing approved actions, running
  jobs) happens server-side with the service role. AI reasoning (plan) and action (tools) are
  separate: the model only *proposes* validated tool calls; a server-side executor enforces
  permissions/approvals and writes the log.

## Tenancy
* Every org-owned table has `org_id`. Child tables use **composite FKs `(parent_id, org_id)`**, so a
  row cannot reference a parent in another org even through a bug.
* RLS helpers (`private.is_org_member`, `private.has_org_role`) are `SECURITY DEFINER`, live in a
  non-exposed `private` schema, and use `search_path = ''`.
* Roles: `owner` / `admin` / `member`. Members manage tasks/documents; admins manage settings,
  knowledge base, workflows; only owners manage membership. An org can't lose its last owner.

## What clients can and cannot do (enforced + tested in `supabase/tests/10_rls.test.sql`)
| Data | Client access |
|---|---|
| tasks, task history | members read/write (history is trigger-written) |
| `integration_credentials` (OAuth tokens) | **none** — no policy, no grant; service role only |
| `action_logs`, usage, workflow runs/steps | read-only; append-only; written by server |
| `assistant_messages` | clients may add `user` messages only; assistant/tool messages server-only |
| `approval_requests` | clients may approve/reject only; payload and execution state immutable |
| `connected_integrations` | read-only status; connect/disconnect via server (token revocation) |
| conversations | private to their author, even within an org |
| storage `documents` bucket | path must start with `<org_id>/`; membership-checked |

## Duplicate-action protection
`action_logs (org_id, idempotency_key)` and `workflow_runs (workflow_id, idempotency_key)` are
unique. A tool call or scheduled firing with the same key can be recorded once; a retry hits the
constraint instead of acting twice.

## Approval policy
`organization_settings.approval_policy` is empty by default → everything consequential (external
email, deletes, payments, signing, critical settings) requires approval. Narrow pre-authorizations
will be validated server-side against an allow-list of actions (Phase 3).

## Prompt-injection stance (to be implemented in Phase 3)
Email, document and web content is passed to the model as clearly delimited untrusted data; the
model's tool calls are checked by the executor regardless of what such content says, and sensitive
tools always route through approvals, so injected text cannot, by itself, cause an irreversible action.
