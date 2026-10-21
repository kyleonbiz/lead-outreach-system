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
* **Edge functions:** `oauth-start` (renamed from `google-oauth-start` in round 2: it serves every provider), `google-oauth-callback`, `microsoft-oauth-callback`, `integration-disconnect`, `provider-data`.

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
* **Formats:** .txt .md .csv .json .html .docx (and .pdf from round 2).
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

---

# Round 2 status (features that need no live account)

Each item below was built and tested without any live service. "Verified" means unit/component/SQL tests and
(where stated) the headless-browser audit — not behavior against a real Supabase, Google, Microsoft, e-mail or chat provider.

## 1. Settings UI for automatic approval rules
### Built
* Settings → **Approvals & automatic permissions**: admins turn on / edit / remove two narrow pre-authorizations
  (send email only to listed addresses/company domains; create calendar events only with listed-domain attendees).
  Always-ask actions (deletes, payments, signing, critical settings) are listed and cannot be changed.
* Rules are validated **three times**: in the UI, in `set_approval_policy()` + a CHECK constraint (migration `0008`), and
  by `parsePolicy()` at run time (invalid → the assistant asks about everything).
* Refused as "too broad": free-mail domains (`@gmail.com`, …), public suffixes (`@co.uk`), bare TLDs, wildcards, bare domains in email
  rules, comma/space-joined or display-name entries, more than one rule per action, unknown fields and any other action.
  Exact addresses at a free-mail provider (`boss@gmail.com`) are allowed.
* Clients can no longer write `approval_policy` directly; the only path is the admin-only RPC, which writes an audit entry
  (who, before, after) to Activity.
### Verified
* 33 new SQL assertions (`70_approval_rules.test.sql`): who may change rules, direct-write bypass closed, 17 hostile policies refused,
  the constraint holds even for the service role, audit trail, cross-organization isolation. A mutation check (disabling the broad-domain test in the SQL)
  makes the suite fail, as it should.
* 12 UI tests + 11 policy tests; a drift test fails if the TypeScript and SQL blocklists differ.
### NOT verified
* The broad-domain list is best-effort (common free-mail providers and public suffixes), not the full Public Suffix List. An admin can still
  list a company domain they do not control; the rule only ever applies to addresses on that exact domain (not subdomains).
* Not exercised against a real Supabase RPC call.

## 2. Notifications: e-mail + Slack / Teams
### Built
* **Delivery outbox** (migration `0009`): every in-app notification fans out (DB trigger) to e-mail deliveries and subscribed channels; the existing
  1-minute `workflow-tick` claims due deliveries (leased, `FOR UPDATE SKIP LOCKED`), sends, retries with back-off (1 m, 5 m, 30 m, 2 h; 5 attempts) and records the outcome.
  Duplicate protection by unique `dedupe_key`; a crashed worker's lease lapses and is retried or failed, never lost or doubled.
* **Hooks:** failed workflows and workflow approvals (already produced by the engine), **chat approvals** (new trigger), **overdue tasks** (new sweep: one summary per
  organization, each task announced once, re-armed when the due date changes or the task is reopened).
* **Per-user preferences** (workflow failed / approval needed / overdue; overdue defaults to off). E-mail goes **only to the member's own confirmed sign-in address**.
* **Slack & Teams webhooks** managed by owners/admins via the `notification-channels` function (create, update, pause, delete, **send test** that reports the real result).
  URLs are validated (https, exact provider hosts, port 443, no credentials/IPs/redirects), encrypted at rest (AES-GCM bound to the channel) and never returned to the browser.
* **Resend** HTTP adapter behind a provider-neutral `Mailer`, with an idempotency key per delivery. Missing configuration is reported as *skipped (missing: …)*, never faked.
* Settings UI: personal e-mail toggles; channel management; Recent deliveries log for admins.
* Messages neutralize untrusted text (Slack `<!channel>`/forged links, Teams markdown links/HTML, e-mail header injection) and only link to internal app paths.
### Verified
* 62 new SQL assertions (`80_notifications.test.sql`): fan-out rules, preferences, dedupe, claim/lease/complete/retry/give-up, unconfirmed addresses never returned,
  secrets unreadable by every client role, cross-organization isolation, hooks, overdue sweep, pruning.
* 150+ unit tests: URL/SSRF validation (every range and bypass tried; two mutation checks confirmed the tests catch regressions), formatting/injection,
  Resend and webhook HTTP behavior and status classification, dispatcher isolation/retry, handler authorization, tick isolation, 10 UI tests.
* A real bug was found by the tests and fixed: Slack's plain-text `text` fallback field was not escaped.
### NOT verified
* No message was ever sent to Resend, Slack or Teams. Whether each service accepts our payloads is untested (mocked HTTP only).
* The migration's SQL ran on plain PostgreSQL 16 with a stub of Supabase's `auth` schema; `auth.users.email_confirmed_at` behavior on a real project is assumed.
* `Deno.resolveDns` availability on the hosted edge runtime is unknown (the layer is skipped if absent).
### Setup you must do
`supabase secrets set RESEND_API_KEY=... NOTIFY_FROM_EMAIL=...` (e-mail only), deploy `notification-channels`, and apply migration `0009`. See DEPLOYMENT.md → Notifications.

## 3. PDF text extraction
### Built
* PDFs are parsed with pdf.js through `unpdf` (a serverless build that needs no worker or canvas). `extractText` is now async.
* Honest failure reasons shown on the document row: **scanned/image-only** (no OCR), **password-protected**, **damaged**, **not actually a PDF**, **over 300 pages**, **timeout (25 s)**.
* A **mixed** PDF is indexed with a trailing note ("1 of 3 pages had no readable text … not included"): content is never silently dropped.
* Safety: the bundled pdf.js has no `eval`/`new Function` (asserted by a test that scans the bundle), no fonts are loaded, scripts never run, the caller's buffer is not mutated.
* 9 reproducible fixtures (`scripts/make-pdf-fixtures.py` → `supabase/functions/_shared/core/docs/fixtures`, ~100 KB): text, multi-page with accents, LibreOffice-produced, scanned,
  mixed, encrypted, truncated, one carrying JavaScript, and 301 blank pages.
### Verified
* 22 new tests (extraction content/order/Unicode, every failure reason, JavaScript PDF never executes, end-to-end through the `document-process` handler incl. row state and "nothing indexed on failure").
* Ran the extractor under **real Deno** with the edge functions' import map on all 9 fixtures: identical results to Node. `deno check` on all functions passes.
### NOT verified
* The **hosted Supabase edge runtime** (CPU/memory limits) — only local Deno. Large PDFs may hit platform limits.
* No OCR, so scanned PDFs are unsupported by design. Table structure and multi-column reading order are best-effort (pdf.js text order).
* Real-world PDF variety is wide: only the 9 fixtures above (reportlab, LibreOffice, pypdf) were tried.

## 4. Team invitations and task assignment
### Built
* **Invitations** (migration `0010`, `invite-member` function): owner-only; roles `admin` or `member` (never `owner`); 256-bit random token that exists in plaintext only in the e-mailed link
  (the database stores SHA-256; no client can read even the hash); single use (row-locked), 7-day default / 30-day max expiry, revocable, one live invitation per address
  (re-inviting replaces the old link), caps (50 pending, 100 per day).
* **Accepting** requires a signed-in user whose **confirmed** e-mail equals the invited address (case-insensitive); a leaked link is useless to anyone else. The token is removed from the
  address bar on arrival and kept in storage only until accepted or failed (so it survives sign-up + e-mail confirmation). Everything is audited.
* **If e-mail is not configured or fails**, the owner gets the link once with the real reason — never a fake success.
* **Team section** in Settings: roster (e-mail addresses visible to owners/admins only), role changes and removal (owner), leave (anyone; the last-owner guard is surfaced), pending invitations with revoke.
* **Task assignment:** "Assigned to" in the task dialog (names from the team directory), assignee shown on rows, "Assigned to me" filter. Membership is enforced by the existing composite foreign key.
### Verified
* 65 new SQL assertions (`90_invitations.test.sql`): who can create, owner role impossible, replay, wrong/unconfirmed address, expiry, revocation, cross-organization use and probing,
  second-organization isolation, caps, directory privacy, lifecycle. Four mutation checks (drop the address match / confirmed requirement / single-use check / allow owner role) each made the suite fail.
* 21 handler tests (hash-only storage, link-only plaintext, fallbacks, error mapping, header-injection-safe subject), 29 UI tests (including exactly-once accept under StrictMode, proven by a mutation check).
### NOT verified
* A real invitation round trip: sign-up -> e-mail confirmation -> accept on a live Supabase project, and Resend delivery. `auth.users.email_confirmed_at` is stubbed locally.
* Concurrent acceptance is serialized by a row lock (`FOR UPDATE`) but was only tested sequentially (replay), not with two simultaneous sessions.
* Ownership transfer is only "promote another member to owner, then leave".

## 5. Outlook mail and calendar (Microsoft Graph)
### Built
* **OAuth** (Microsoft identity platform v2, delegated permissions, work/school and personal accounts): minimal scopes per capability (`Mail.ReadWrite`+`Mail.Send`; `Calendars.ReadWrite`),
  account picker, signed state, encrypted credentials bound to the integration (the same AES-GCM code as Google), required-permission check, disconnect.
* The OAuth handler was refactored around a per-provider strategy; **every existing Google test passes unchanged**. `google-oauth-start` became the provider-neutral `oauth-start`; a
  `microsoft-oauth-callback` function was added. Credential loading/refresh was extracted into one shared adapter used by both providers (Microsoft rotates refresh tokens; this is stored).
* **Mail adapter** behind the existing `EmailProvider`: search (a documented query language translated to Graph, unsupported operators refused), threads as plain text, drafts, in-thread reply drafts, send.
  **Calendar adapter** behind `CalendarProvider`: agenda, free/busy, create/update (Graph sends the invitations; the existing approval rules still gate it).
* Runtime picks the connected provider (`pickProvider`: working beats broken, newest wins). Integrations UI, Email/Calendar/Overview wording and connect errors are provider-neutral; the
  Overview no longer says "arrives in Phase 4" for connected accounts (a leftover placeholder).
### Verified
* 77 new tests with mocked HTTP: auth URL/scopes/tenant validation, token and refresh behavior including rotation and re-auth, Graph error classification, id validation (no path/OData injection),
  query parsing and planning (`$filter`/`$search` constraints), message/thread/draft/reply/send flows incl. cleanup of half-made drafts, calendar normalization/UTC/all-day, handler flows for start/callback/disconnect.
* The tests found two real bugs, both fixed: an operator with no value (`from:`) was searched as a literal word, and the id validator allowed `/` and `.`. Two mutation checks confirm the injection tests bite.
* `deno check` passes for all 13 functions.
### NOT verified
* **Nothing has talked to Microsoft.** Request shapes follow Microsoft's published Graph v1.0 documentation but were never exercised: in particular `$search` syntax, `createReply`, the `Prefer: outlook.timezone="UTC"`
  behavior, calendarView paging, and consent behavior in tenants with admin restrictions. Expect small fixes on the first live run.
* Personal (Outlook.com) vs work/school accounts differ in subtle ways (for example `mail` can be empty; handled by falling back to the sign-in name) and only one path was reasoned about, not run.
* App-registration and publisher-verification steps are documented, not performed.

## 6. Data export, ownership transfer, account deletion
### Built
* **Ownership transfer** (`transfer_ownership` RPC, migration `0011`): owner-only, target must be a member, optional step-down, audited; the last-owner guard still applies underneath.
* **Organization export** (`export-org-data`): owners get a zip of every exportable table; owners/admins get the audit log (JSON + CSV). Reads use the requester's own token (RLS), tables are a fixed whitelist,
  secrets and private conversations are never read, CSV cells are defanged against spreadsheet formulas, 5-minute throttle, audited, truncation reported in the manifest and README.
* **Account deletion** (`delete-account`): preview of what will happen, e-mail confirmation, recent-sign-in requirement, blocked while the person is the only owner of an organization with other members,
  explicit acknowledgement of each organization that is deleted with them (files first, then data), disconnects the integrations they connected (reusing the tested revoke step), anonymizes their e-mail in audit text, deletes the account last.
* Settings → **Data & privacy** UI for all three.
### Verified
* 43 new SQL assertions (`95_account_data.test.sql`): transfer rules incl. cross-organization and anonymous attempts, step-down, plan classification (agrees with what the database guard actually allows), log scrubbing
  (case-insensitive, regex-safe, never touches other people's entries), exactly what survives a user's deletion, organization cascade. A mutation check on the scrub confirms the test bites.
  A test found a real bug (case-sensitive scrub) which was fixed.
* 38 handler tests (22 export: authorization, scoping, whitelist, truncation, throttling, CSV injection; 16 deletion: every refusal, step order, partial failure + retry, no data leakage) and 14 UI tests (gating of the delete button).
* `deno check` passes for all 15 functions.
### NOT verified
* Nothing ran against a real Supabase: `auth.admin.deleteUser`, Storage `list`/`remove`, a real zip download in a browser, and the real `last_sign_in_at` behavior are untested.
* Whether Supabase refreshes `last_sign_in_at` on token refresh (which would weaken the "recent sign-in" gate) is assumed, not confirmed.
* Concurrency: two simultaneous deletions or an export during a deletion were not tested.

