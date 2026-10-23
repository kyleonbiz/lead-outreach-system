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

## AI learning mode (Settings → AI learning)
A business profile plus memories you control. When ON, they are added to what the assistant and the follow-up, research and
marketing agents are told (never overriding the safety rules); when OFF nothing is shared. Memories come from you, from the
assistant (you approve each), or from suggestions based on how you edit follow-up drafts (you accept or dismiss each).
Contact details and secrets are rejected. Stored in the app's own data; "Forget everything" deletes it all.

## Connect ChatGPT / Claude Cowork (Settings → Connectors, and the Approvals inbox)
The app serves an MCP connector at `/mcp` (POST; Bearer key, or the key in the URL as `/mcp/<key>`). Create keys in Settings → Connectors
(read-only or "can propose", expiry, contact details hidden unless shared; shown once, stored hashed, revocable). Connected AI apps can look
things up; anything that would change data is queued in **Approvals** and runs only when you approve it (they cannot approve their own
requests). Never offered: sending email, resuming sending, changing caps, un-blocking contacts. Cloud apps (ChatGPT) need the app reachable
over HTTPS. For Claude Cowork / Claude Desktop on your own computer use the stdio bridge `mcp_stdio.py` (config shown in the Connectors tab).
Limitation: no OAuth yet, so the secret-URL / Bearer-key forms are used; treat a key like a password.
