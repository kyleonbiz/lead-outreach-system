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
* **PDF**: text-based PDFs are read (pdf.js via `unpdf`). **Scanned/image-only PDFs are not** — there is no OCR; they fail with a clear reason, and a PDF with some
  scanned pages is indexed with a note listing how many pages were left out. Password-protected PDFs, damaged files and PDFs over 300 pages also fail with a reason.
  Layout is flattened to reading-order text (tables lose their grid). Hosted edge functions have CPU-time limits that were never exercised: a very large or complex PDF
  may fail there with the timeout message (our own limit is 25 s) even though it parses locally.
* Email: Gmail and Outlook (Microsoft Graph). No attachments, labels/categories or folder management; reminders/follow-ups are tasks.
  **Outlook search uses a small shared query language** (`from:`, `to:`, `subject:`, `is:unread|read`, `in:inbox|sent|drafts|trash`, `newer_than:`, `older_than:`, `after:`, `before:`, words and quoted
  phrases). Gmail-only operators, `OR`, parentheses and `-` exclusions return an explicit error for Outlook rather than silently returning wrong results. Text searches in Outlook can't be combined
  with Graph filters, so read-state/date limits are applied after fetching (up to 100 messages), which can return fewer results than asked for.
* Outlook sending creates a draft and then sends that draft (Graph's one-call send returns no message id); if the send step fails the draft remains in Drafts. Replies keep the thread but not the quoted history.
* Outlook calendar events are created as **UTC instants** (same moment, displayed in each person's own zone) rather than named zones, so Outlook's "time zone" field will read UTC. All-day events are turned
  back into dates using the organization's time zone, which is wrong if the mailbox uses a different zone. Free/busy is derived from the calendar view (no `getSchedule`), primary calendar only.
* Microsoft cannot be revoked remotely (see DEPLOYMENT.md); a connected Gmail **and** Outlook account means the most recently connected one is used.
* Calendar: primary calendar only; no recurring-event creation or room/resource handling.
* Workflows: form-based editor (no drag-and-drop canvas); events limited to `task.overdue` and `document.ready`; no version history UI;
  each tick runs at most 3 runs (long workflows may need the edge-function time limit raised or the run split).
* Teams: invitations (owner-only, e-mailed single-use links), role changes, removal and leaving are built; task assignment (dialog, row, "Assigned to me") is built.
  Not built: ownership **transfer** flow beyond promoting a member to owner, notifying someone when a task is assigned to them, and bulk invitations.
  Invitation links are delivered by e-mail only if Resend is configured; otherwise the owner copies the link.
* Task attachments, usage dashboards/billing, per-document sharing, search in languages other than English.
* Data export covers organization data and the audit log; there is no per-person export of your own conversations, and the uploaded document **files** themselves are not in the zip (details only). Large tables are
  capped (see `EXPORT_TABLES`) with the newest rows kept and the truncation stated in the zip. Exporting very large organizations may hit edge-function memory/time limits that were never exercised.
* Account deletion removes the person's sign-in, profile, private conversations and preferences, disconnects their connected accounts and scrubs their e-mail address from audit-log text. It does **not** delete
  organization content they created (tasks, documents, workflows stay with the organization, unlinked from them), does not purge database backups, and cannot revoke Microsoft tokens remotely.
  Audit entries remain (anonymized) as a security record. Deleting an organization removes its Storage files first and fails (leaving the account intact) if the files cannot be listed or removed.
* Notifications: in-app, e-mail (Resend) and Slack/Teams webhooks. No push/SMS. E-mail needs a Resend account and a verified sending domain.
  **Never run against Resend, Slack or Teams**: request shapes follow their public docs and are tested against mocked HTTP only. The Teams card uses the
  Adaptive Card format used by Teams Workflows; if a tenant's webhook rejects it, the failure is shown on the channel and in Recent deliveries.
* Webhook SSRF protection is an exact provider-host allow-list plus a public-address DNS check. The DNS check is separate from `fetch`, so it cannot
  fully rule out DNS rebinding, and it is skipped (the allow-list still applies) on runtimes without `Deno.resolveDns`.
* Delivery depends on the scheduler (`workflow-tick`) running every minute. Delivery records are pruned after 30 days (90 for failures).

## Security notes / follow-ups
* Google "restricted" Gmail scopes require Google's verification (and usually a security assessment) before serving the public.
* A sole owner cannot be deleted from `auth.users` while they are an organization's last owner (by design; transfer ownership first).
* `npm audit`: 7 findings, all in Tailwind 3's build-time toolchain (not shipped). Resolve by migrating to Tailwind 4.
* Rate limiting is per user per minute inside the assistant endpoint plus the per-org daily token budget; other endpoints rely on
  Supabase's platform limits. Add an edge/WAF limiter if exposed publicly at scale.
* Recurring tasks use UTC interval arithmetic (a DST change can shift local time by an hour).

## Reasonable next integrations
Gmail push → `email.received` workflow trigger · accounting (QuickBooks/Xero,
read-only first) · e-signature (always behind approval) · SMS/phone reminders · pgvector semantic search.
