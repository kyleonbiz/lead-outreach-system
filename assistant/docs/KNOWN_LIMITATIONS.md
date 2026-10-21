# Known limitations and future work

Plain list of what is **not** done or **not proven**. Nothing here is hidden behind a UI that pretends otherwise.

## Never run against live services
* No part of the backend has run on a real Supabase project; **no edge function has been served**; the Anthropic, Gmail, Google Calendar
  and Google OAuth integrations have only been exercised against mocked HTTP. The first real run will likely reveal small
  integration bugs (request shapes, scopes, headers). Start with the smoke test in DEPLOYMENT.md.
* SQL (migrations, RLS, queue functions) is tested on plain PostgreSQL 16 with a minimal stub of Supabase's `auth`/`storage` schemas.
* pg_cron scheduling is documented, not exercised. The Word export has never been opened in Word.
* Prompt-injection defenses are layered mitigations tested with a scripted "obedient" model, not measured against real models.

## Product gaps
* **PDF** text extraction and OCR are unsupported (shown to the user as a failure reason).
* Email: Gmail only (adapter interface ready for Outlook). No attachments, labels or folder management; reminders/follow-ups are tasks.
* Calendar: primary calendar only; no recurring-event creation or room/resource handling.
* Workflows: form-based editor (no drag-and-drop canvas); events limited to `task.overdue` and `document.ready`; no version history UI;
  each tick runs at most 3 runs (long workflows may need the edge-function time limit raised or the run split).
* Teams: roles exist (`owner/admin/member`) and RLS enforces them, but there is **no invitation UI** — members are added via SQL
  today. Task assignment columns exist; assignment UI does not.
* Task attachments, usage dashboards/billing, per-document sharing, search in languages other than English.
* No account deletion / data export flow, no audit-log export.
* Auto-approval rules are enforced server-side but there is no Settings UI to create them yet.
* Notifications are in-app only (no email/push).

## Security notes / follow-ups
* Google "restricted" Gmail scopes require Google's verification (and usually a security assessment) before serving the public.
* A sole owner cannot be deleted from `auth.users` while they are an organization's last owner (by design; transfer ownership first).
* `npm audit`: 7 findings, all in Tailwind 3's build-time toolchain (not shipped). Resolve by migrating to Tailwind 4.
* Rate limiting is per user per minute inside the assistant endpoint plus the per-org daily token budget; other endpoints rely on
  Supabase's platform limits. Add an edge/WAF limiter if exposed publicly at scale.
* Recurring tasks use UTC interval arithmetic (a DST change can shift local time by an hour).

## Reasonable next integrations
Outlook mail/calendar adapters · Gmail push → `email.received` workflow trigger · Slack/Teams notifications · accounting (QuickBooks/Xero,
read-only first) · e-signature (always behind approval) · SMS/phone reminders · pgvector semantic search.
