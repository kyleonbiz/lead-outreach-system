# Phase 1 – Repository inspection

## What the repository was
`lead-outreach-system` is a Python 3.11 + GitHub Actions cold-outreach pipeline for
Aurum Ventura (~2,700 lines Python, 9 workflows, no tests, no `requirements.txt`
— workflows `pip install requests gspread google-auth` inline).

| Area | Files | State |
|---|---|---|
| Lead discovery | `find_leads.py`, `find_intent_leads.py`, `pick_next_campaign.py` | Working, scheduled |
| Enrichment | `enrich_leads.py` | Working |
| Sending (Microsoft Graph) | `send_emails.py` | Working, live (TEST_MODE=false), ramping 150→300/day |
| Monitoring | `check_bounce_rate.py`, `daily_summary.py`, `supervisor.yml`, Discord webhooks | Working |
| Reporting | `export_dashboard_data.py`, `docs/index.html` (static, GitHub Pages) | Working |
| Organization | `organize_by_industry.py`, `write_to_sheets.py` | Working |
| Social | `create_fb_posts.py` (uses ANTHROPIC_API_KEY) | Working |

Infra: Google Sheets is the datastore, GitHub Actions the scheduler, Google WIF for
auth, Discord for alerts. 12 repository secrets are in use.

## Findings
* `send-outreach-auto.yml` at the repo root is a **stale, divergent copy** of
  `.github/workflows/send-outreach-auto.yml` (hourly cron, 10/run cap). It is not
  executed by GitHub. Left untouched; recommend deleting it separately.
* No tests, no dependency pinning, README is two lines.
* Nothing in the repo is reusable by the new product except general patterns
  (Anthropic usage in `create_fb_posts.py`, Discord alerting).

## Decision: where the new product lives
The outreach system is **live and sending email**. The new product has a
different language (TypeScript), runtime (Supabase/Vercel) and purpose.
It is built in `assistant/` as a self-contained app. **No existing outreach file
or workflow is modified.** The two can be split into separate repositories later.

## Implementation plan
| Phase | Scope |
|---|---|
| 2 | Vite/React/TS/Tailwind shell, Supabase Auth, multi-tenant schema + RLS (tested), onboarding, dashboard, task manager, activity center |
| 3 | Assistant orchestration: provider adapter (Anthropic), validated tool registry, plan/approve/execute loop, logging |
| 4 | Gmail + Google Calendar OAuth, encrypted token storage, provider adapters |
| 5 | Document upload (Storage), retrieval, generation/export |
| 6 | Workflow engine, job queue (pg_cron + edge worker), retries, notifications |
| 7 | Integration/authz tests, failure handling, responsive polish, deployment docs |
