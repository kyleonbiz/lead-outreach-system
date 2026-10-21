# Phase 2 status (foundation)

## Built and verified
* **App shell:** Vite + React 18 + TypeScript + Tailwind; responsive nav (10 sections), light/dark,
  accessible dialog/forms. Verified in headless Chromium at 1280px and 390px (no console errors, no
  horizontal overflow) against a stubbed API.
* **Auth:** Supabase email/password sign-up/sign-in/out, email-confirmation messaging.
* **Tenancy:** onboarding creates an org via `create_organization()`; workspace switcher; roles.
* **Database:** all 21 tables from the spec, constraints, indexes, triggers, RLS, column grants,
  storage policies. `npm run test:db`: **56 assertions pass** (cross-tenant read/write/escalation,
  secrets, append-only logs, approvals, recurrence, storage).
* **Tasks:** full CRUD, filters, due/priority/category/recurrence, completion via DB function
  (recurring tasks spawn the next occurrence), completion history, optimistic completion.
* **Activity center + dashboard:** real data from `action_logs`, `approval_requests`,
  `connected_integrations`, `workflows`, `tasks`.
* **Tests:** 15 frontend tests (Vitest) + 56 database assertions.

## Not verified / caveats
* **Never run against a live Supabase project** (none exists yet; no credentials in this
  environment). DB tests use a local Postgres 16 with a minimal stub of Supabase's `auth`/`storage`
  schemas, so behaviour of real GoTrue/PostgREST/Storage, and the email-confirmation round trip,
  are untested. First real-project run is the first thing to do (SETUP.md).
* The browser run used an in-test fake API; it proves the UI renders and calls the right endpoints,
  not that a real backend accepts them.
* Types in `src/lib/types.ts` are hand-written; replace with `supabase gen types` once linked.
* Recurrence uses UTC interval arithmetic (a DST change can shift the local time by an hour).
* Deleting an auth user who is the sole owner of an org is blocked by the last-owner guard.

## Not built (by design, later phases)
Assistant chat/orchestration & tools (3) · Gmail/Calendar OAuth (4) · documents upload, retrieval,
generation, task attachments (5) · workflow builder/engine, job runner, notifications (6) ·
rate limiting, integration tests against live services, deployment of backend (7).
The Assistant, Calendar, Email, Documents and Workflows pages are labelled placeholders.

## Known tooling items
* `npm audit`: 7 findings, all in Tailwind 3's build-time toolchain (not shipped to users).
  Resolved by migrating to Tailwind 4, deferred.

---

# Phase 3 status (assistant orchestration)

## Built
* **Core (pure TS, runs under Vitest and Deno):** validated tool registry (zod → JSON schema), approval
  policy engine, provider adapter interface with **Anthropic** (retry/backoff, error mapping) and a scripted
  fake for tests, orchestrator loop (plan → validate → policy → execute/queue → report), shared
  idempotent tool executor, approval execution (re-validates stored payload, enforces expiry, at-most-once),
  rate limiter, log redaction, prompt-injection envelope.
* **Tools:** `tasks.list/create/update/complete`, `tasks.delete` (always needs approval), `knowledge.search`.
* **Endpoints (edge functions):** `assistant-chat`, `assistant-approve` — thin wrappers over tested handlers.
* **DB:** migration `0003` — `agent_task_op()` (actor-attributed, org-scoped task operations).
* **UI:** Assistant page (conversations, chat, inline approval cards, "needs setup" state), dashboard command
  box → assistant, approve/decline from the dashboard.

## Verified
* 63 frontend/core tests (orchestrator honesty on tool failure & provider outage, approvals, injection wrapping,
  policy lookalike-domain bypasses, handler authorization 401/403/404/409/410/429/503, Anthropic adapter against
  mocked HTTP).
* DB: 71 assertions incl. cross-tenant and service-role org-scoping of `agent_task_op`.
* `deno check` passes for both edge functions (type-level only).

## NOT verified
* **No edge function has been run** (no Supabase project, no Deno serve), and the Anthropic adapter has never
  spoken to the real API — only mocked HTTP. First live run may surface request-shape issues.
* `knowledge.search` calls an RPC (`search_knowledge`) that is added in Phase 5; until then it returns an error
  to the model (reported honestly).
* Prompt-injection defenses are layered mitigations, validated with a scripted "obedient" model; real-model
  resistance is untested.
* Pre-authorization rules (Settings UI to edit them) are enforced server-side but have no editing UI yet.

## Needed to go live
Supabase Edge Function secrets: `ANTHROPIC_API_KEY` (required), `ASSISTANT_DEFAULT_MODEL` (optional),
`ASSISTANT_MESSAGES_PER_MINUTE` (optional, default 12), `APP_URL`. Deploy: `supabase functions deploy assistant-chat assistant-approve`.

---

# Phase 4 status (Gmail + Google Calendar)

## Built
* **Provider-neutral ports** (`EmailProvider`, `CalendarProvider`): Gmail and Google Calendar are adapters behind
  them; Outlook can be added without touching tools, handlers or UI.
* **OAuth:** least-privilege scopes (no full-mailbox scope), offline access, HMAC-signed 10-min `state`,
  callback re-checks that the initiator is still an admin, rejects missing refresh token / partially granted scopes,
  every failure is redirected to the UI with a plain-language reason and written to the audit log.
* **Credentials:** AES-256-GCM, bound to the integration row (AAD), stored only in `integration_credentials`
  (no client access at all), refreshed centrally (one refresh under concurrency), `needs_reauth` on revoked tokens.
* **Disconnect:** revokes at Google, deletes stored credentials, marks revoked, audits; reports honestly if Google
  did not confirm revocation.
* **MIME builder** blocks header injection (CR/LF), base64 bodies.
* **Tools:** `email.search/get_thread/triage/create_draft`, `email.send` (approval), `calendar.list_events/free_busy`,
  `calendar.create_event` / `update_event` (approval; explicit time zone + attendee list required).
* **Rules:** transparent urgent/needs-reply classification with reasons; org-configurable keywords, VIP and ignore lists.
* **UI:** working Connect/Disconnect, Email triage page, Calendar agenda page, email-rules settings.
* **Edge functions:** `google-oauth-start`, `google-oauth-callback`, `integration-disconnect`, `provider-data`.

## Verified
* 119 passed (119) frontend/core tests total; DB: 83 assertions (new: credentials unreadable by any client role,
  integration state not client-editable, email-rules authorization).
* `deno check` passes for all 6 functions.
* Adapters and OAuth helpers are tested against **mocked HTTP only**.

## NOT verified
* **Nothing has talked to Google.** Real request/response shapes, consent-screen behavior, token refresh and
  revocation, Gmail threading headers and Calendar invitations are untested against the live APIs.
* Google restricted-scope verification (Gmail) is an external process not started.
* Reminders for follow-ups are expressed as tasks (via `tasks.create`); there is no separate "snooze until reply" mechanism.
* Meeting prep/summaries are produced by the assistant from `calendar.*` + `email.*` results; no dedicated feature.

## Needed to go live
Secrets in docs/SETUP.md: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`,
`TOKEN_ENCRYPTION_KEY`, `APP_URL`; a Google Cloud project with the two APIs enabled and an OAuth web client.

---

# Phase 5 status (documents, knowledge base, generation)

## Built
* **Upload → process → search:** files go to the private `documents` bucket under `<org_id>/…`; `document-process`
  extracts text, splits it into searchable chunks (Postgres full-text search: no embedding service, no extra cost) and,
  if an AI key is configured, produces a summary plus dates / obligations / action items.
* **Formats:** .txt .md .csv .json .html .docx. **PDF is explicitly NOT supported** — it fails with that exact reason shown on the row.
* **Knowledge base:** admin-editable entries (company, services, hours, policies, FAQs, guidelines, contacts, SOPs). A digest of the
  trusted kinds is added to the assistant's system prompt; everything is also searchable via `knowledge.search`.
* **Search:** `search_knowledge()` (SECURITY INVOKER, RLS-scoped) over KB + document chunks, with highlighted snippets, used by both the UI and the assistant.
* **Generation/export:** `documents.generate` saves assistant-written Markdown as a document (indexed immediately);
  download as Markdown or export to Word (.docx built in the browser).
* **Tools:** `documents.list`, `documents.get`, `documents.generate`. Document text is always treated as untrusted
  (nonce-delimited envelope; analysis runs with no tools).
* **DB:** migration 0005 (chunks, tsvector indexes, search RPC, uploader-can-delete storage policy).

## Verified
* 145 passed (145) frontend/core tests total; DB: 102 assertions (new: search tenant isolation, chunks/summary/status are server-written only,
  KB admin-only, storage delete rules).
* DOCX round trip (generate → extract), chunk size limits, injection envelope around analysis, handler failure paths.
* `deno check` passes for 7 functions.

## NOT verified
* Never run against real Supabase Storage / a real browser upload; the DOCX produced has not been opened in Microsoft Word
  or LibreOffice (only parsed by our own extractor). Treat Word export as unverified until opened once.
* The analysis prompt has never been run against a real model; output quality and JSON compliance are untested.
* English-only stemming (`to_tsvector('english')`); other languages will search poorly.
* No OCR; scanned documents and PDFs are unsupported. No per-document sharing controls (everything is org-wide).
* "Task attachments" (linking documents to tasks) is not implemented.

## Needed to go live
Deploy `document-process`; `ANTHROPIC_API_KEY` for summaries (optional: documents work without it).

---

# Phase 6 status (workflows, background execution, notifications)

## Built
* **Declarative definitions only:** step types `tool`, `summarize`, `approval`, `notify`; conditions are structured
  (no expression language); templates are pure data lookups (`{{steps.x.output.y}}`, `{{time.today_start}}`), with
  prototype/constructor access blocked. Tools must exist in the registry. No scripting, no arbitrary HTTP, no eval.
* **Server-validated saves:** clients cannot insert workflows/versions or edit trigger/definition columns (privileges revoked);
  `workflow-save` validates (structure, unknown tools, forward references, cron) and versions every change.
* **Engine:** ordered execution with conditions, per-step retries with exponential backoff (permanent "not connected"
  errors are not retried), `on_failure: continue`, sensitive tool steps + explicit approval steps (run pauses, resumes after the
  decision; rejection fails the step), **at-most-once side effects** (idempotency key per run/step/attempt; a crashed worker's
  half-finished step is failed, never repeated), summary step that is told which sections failed.
* **Durable queue (Postgres):** idempotent enqueue (`UNIQUE(workflow, key)`), `FOR UPDATE SKIP LOCKED` claiming with leases
  (crashed runs are reclaimed), retry scheduling, approval resume, event dispatch (`task.overdue`, `document.ready`).
* **Triggers:** manual (`workflow-run`), schedule (cron evaluated in the org time zone, DST-safe, catch-up lookback),
  event. `workflow-tick` is authenticated by a constant-time-compared `CRON_SECRET`.
* **Notifications:** workflow failures and approval requests (bell in the app shell, mark read).
* **UI:** workflow list, enable/disable, run now, visual step flow, run history with per-step status/errors/summary text,
  validated editor (add/remove/reorder steps, schedule presets), daily-briefing template, briefing card on the dashboard.
* **Migration 0006** + `supabase/cron.example.sql`.

## Verified
* 195 passed (195) frontend/core tests; DB: 140 assertions (new: duplicate-run prevention, skip-locked claiming and lease reclaim,
  retry timing, approval resume, event dedupe/fan-out only to enabled listeners in the same org, client privilege revocations,
  tenant isolation of runs/events/steps).
* Engine tested for: ordering, templating, conditions, failure stop/continue, retry/backoff, approvals (approve/reject/gate),
  crash at-most-once, AI-not-configured, transient AI errors; cron incl. DST; hostile definitions and templates.
* `deno check` passes for 10 functions.

## NOT verified
* **The scheduler has never fired**: pg_cron/pg_net wiring is documentation only (project-specific), and no edge function has run.
  The SQL queue functions are tested on plain Postgres 16, not on Supabase.
* Run-time of long workflows against the edge function wall-clock limit is untested; each tick processes at most 3 runs.
* Per-user (not per-org) workflow notifications are not implemented; notifications are org-wide.
* The email.received / calendar-change event triggers are NOT implemented (would need Gmail push / webhooks); only
  `task.overdue` and `document.ready` exist.
* Visual editing is a form-based step list, not a drag-and-drop canvas.
* Workflow versions are stored but there is no UI to browse or roll back to an older version.

## Needed to go live
`CRON_SECRET`; deploy `workflow-save`, `workflow-run`, `workflow-tick`; run `supabase/cron.example.sql` with pg_cron + pg_net + Vault enabled;
`ANTHROPIC_API_KEY` for summary steps (the briefing fails visibly without it).

---

# Phase 7 status (hardening, tests, polish, deployment docs)

## Built
* **Gap review fixes:** (1) approvals that expire now also fail any workflow step waiting on them (`expire_approvals()`, run by the tick);
  (2) per-organization **daily AI token budget** (`ASSISTANT_DAILY_TOKEN_LIMIT`) with a clear `usage_limit` error; (3) request bodies capped at
  1 MB, CORS/error-boundary helpers extracted into pure, tested code (`core/http.ts`) so unexpected errors never leak details.
* **Security headers:** strict CSP (no inline script, no eval), `frame-ancestors 'none'`, HSTS, nosniff, referrer/permissions policies in
  `vercel.json`; the inline theme script moved to `public/theme-init.js`; Zod JIT disabled in the browser so it never attempts `eval`.
* **Integration tests:** an authorization matrix over all 9 endpoints × 5 kinds of caller (anonymous, outsider, member, admin, owner), a full
  chat → approval → execution loop (queued, not run, approved, run once, double-submit rejected, audit trail), and a full
  tick → workflow → approval pause → approve → resume → completion flow with duplicate-trigger protection.
* **Accessibility/responsive:** fixed WCAG AA contrast failures in the design tokens (muted, warn, ok), non-color link affordance in text,
  and a cramped mobile Documents row.
* **Docs:** `DEPLOYMENT.md` (ordered rollout with checks, smoke test, cost controls, operations/incident notes) and `KNOWN_LIMITATIONS.md`.

## Verified
* 218 passed (218) in 21 passed (21) files; DB: 148 assertions; `deno check` on 10 functions; production build.
* **Real-browser audit of the production build** served with the exact headers from `vercel.json`, over a fake API, for all 10 pages at
  390 / 768 / 1280 px (30 combinations): **0 CSP violations, 0 horizontal overflow, 0 axe-core WCAG 2 A/AA violations**.
  (This proves the UI under the CSP and its accessibility on stubbed data — not backend behavior.)

## NOT verified
* Everything listed in `KNOWN_LIMITATIONS.md` → "Never run against live services". In particular the CSP was tested with a fake Supabase
  host matching `https://*.supabase.co`; a custom Supabase domain needs `connect-src` updated.
* Screen-reader behavior beyond automated axe rules and keyboard use of the custom dialogs/popovers was not manually tested.
* No load/performance testing.
