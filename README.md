# lead-outreach-system
# Scheduler reactivated

## Hosted service

`docker build -t aurum . && docker run -p 8000:8000 -v aurum-data:/data --env-file .env aurum`

Run exactly **one** instance (one scheduler). Required env: the same values as the GitHub secrets
(`SHEET_ID`, `MS_*`, `SENDER_EMAIL`, `PLACES_API_KEY`, `DISCORD_WEBHOOK_URL`, ...), plus
`GOOGLE_SERVICE_ACCOUNT_JSON` (service-account key) and `APP_API_KEY` (protects the control API).
Optional: `DAILY_SEND_CAP`, `PER_RUN_CAP`, `CAMPAIGN_ID`, `EMAIL_SENDING_ENABLED`.
Open the service URL in a browser and sign in with `APP_API_KEY`. The sidebar has the dashboard, calendar, contacts (leads, referral partners and people you add, with notes and a do-not-contact switch), leads, referral partners, follow-ups, outreach log, campaign queue, market research, marketing, and settings (pause sending, daily caps, jobs).
API (send `X-API-Key`): `GET /status`, `POST /jobs/{name}/run`, `POST /sending/pause`, `POST /sending/resume`, `GET|PUT /settings`.

## Local mode (no hosting, no Google, no email)

`pip install -r requirements.txt` then `python run_local.py path/to/workbook.xlsx` (or a folder of CSVs named
`Leads.csv`, `Referrals.csv`, `Outreach_Log.csv`, `Campaign_Queue.csv`). Open http://127.0.0.1:8000/, key `local`.
Read-only: the scheduler is off, jobs cannot run, and nothing is sent.

## Agents (sidebar: Follow-ups, Market research, Marketing)
On-demand only; nothing runs on a timer and nothing posts. Needs `ANTHROPIC_API_KEY` (optional `CLAUDE_MODEL`).
- **Follow-up**: drafts follow-ups for contacted leads with no reply; you edit/approve; `send_followups` (manual job) sends approved drafts, one attempt each, under the same cap/suppression/stop rules. Disabled in local mode.
- **Market research**: suggests where to prospect next from your own results (aggregates only go to the model).
- **Marketing**: this week's Facebook posts (same rules as `create_fb_posts.py`) and SEO page ideas.
Agent output is stored in `DATA_DIR/agents/`, not in your sheets. "They replied" / "Never email" add to `DATA_DIR/agents/suppression.json`, which the main sender also honors.

## In-app assistant (top bar → Assistant)
Type a task in plain English. It looks things up with read tools (contacts, dashboard, follow-up drafts, calendar, status) and
PROPOSES changes (add note/contact/event, do-not-contact, approve/reject a follow-up draft, run an agent or job, pause/resume sending,
set caps) as approval cards. Nothing changes until you approve, and the server runs exactly the call you approved. It can never send an
email itself and cannot start the main outreach sender; follow-ups send only via the approved-drafts job, after you confirm.
Executed actions are logged (`GET /api/assistant`). Needs `ANTHROPIC_API_KEY`. Note: it sends the data it looks up to the AI service.
