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
