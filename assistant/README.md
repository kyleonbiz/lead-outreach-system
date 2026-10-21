# Aide – AI business assistant

*Delegate the work. Keep control.*

A multi-tenant SaaS where a small-business owner hands routine admin work (email, calendar,
tasks, documents, workflows) to an AI assistant that acts only through authorized, audited
tools, and asks before anything sensitive.

> This app lives in `assistant/` inside the `lead-outreach-system` repository. It is
> independent of the Python outreach pipeline in the repo root, which it does not touch.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Repo inspection, plan | built — `docs/PHASE1_REPORT.md` |
| 2 | Shell, auth, schema + RLS, dashboard, tasks, activity | built and tested |
| 3 | Assistant orchestration, tool registry, approvals | built and tested (mocked model) |
| 4 | Gmail + Google Calendar (OAuth) | built; **mocked HTTP only** |
| 5 | Documents, knowledge base, search, generation | built and tested |
| 6 | Workflows, durable queue, scheduler, notifications | built and tested; **scheduler never fired** |
| 7 | Hardening, integration + authorization tests, CSP, a11y, deployment docs | built and tested |

**Nothing has run against live Supabase / Anthropic / Google yet** — read [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) and per-phase
status in [docs/STATUS.md](docs/STATUS.md) before trusting it. Sections of the UI whose backend is not configured say so; nothing is simulated.

Tests: 218 passed (218) in 21 passed (21) files (Vitest) plus 148 database assertions (`npm run test:db`).

## Quick start

```bash
cd assistant
npm install
cp .env.example .env.local      # fill in your Supabase URL + anon key
npm run dev
```

Without those variables the app shows a setup screen rather than failing. Full instructions
(creating the Supabase project, applying migrations, auth settings): **[docs/SETUP.md](docs/SETUP.md)**. Production rollout: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck + production build |
| `npm test` | Frontend unit/component tests (Vitest) |
| `npm run test:db` | Applies all migrations to a throwaway Postgres and runs the RLS/tenancy/queue test suites |
| `npm run check:functions` | Type-checks every edge function with Deno |

## Layout

```
src/                  React + TypeScript + Tailwind app
  features/           auth, org (tenancy), tasks, assistant, documents, workflows, integrations, notifications
  pages/              one file per nav item
supabase/functions/   edge functions (thin) + _shared/core (pure TypeScript: tools, policy, orchestrator, workflow engine, adapters)
supabase/migrations/  schema, RLS, grants, queue functions, storage policies (source of truth)
supabase/tests/       SQL tests run by scripts/test-db.sh
docs/                 setup, deployment, architecture & security model, status, known limitations
```
