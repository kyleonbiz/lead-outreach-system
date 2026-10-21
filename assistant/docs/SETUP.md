# Setup

## Prerequisites
* Node 20+ (developed on 22)
* A Supabase project (free tier is fine to start)
* For `npm run test:db`: PostgreSQL 15+ server binaries (`initdb`, `pg_ctl`) on the machine

## 1. Create the Supabase project
1. https://supabase.com → New project. Save the database password somewhere safe.
2. **Project Settings → API**: copy the *Project URL* and the *anon / publishable* key.
   Never put the `service_role` key in the frontend or in any `VITE_` variable.

## 2. Apply the database
Either use the Supabase CLI:
```bash
npm i -g supabase            # or: npx supabase ...
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase db push             # applies supabase/migrations/*.sql in order
```
or paste `0001_core_schema.sql`, then `0002_storage.sql` into **SQL Editor** and run them.

Migrations are deny-by-default: every table has RLS enabled and `anon`/`authenticated` start
with **no** privileges; each migration grants exactly what the client needs. A new table needs
an explicit `grant` and policies, or the client cannot see it. This is intentional.

## 3. Authentication settings
**Authentication → Providers → Email**: keep *Confirm email* on for production.
**Authentication → URL Configuration**: set *Site URL* to your app URL
(`http://localhost:5173` locally) and add your Vercel URL to *Redirect URLs*.

## 4. Configure and run the app
```bash
cp .env.example .env.local   # fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```
Sign up → confirm the email → name your business → you land on the dashboard.

## 5. Verify
```bash
npm run typecheck && npm test      # frontend
npm run test:db                    # migrations + 56 tenancy/RLS assertions
```

## Server-side secrets
Set these as **Supabase Edge Function secrets** (`supabase secrets set NAME=value`), never in `.env.local`
and never in a `VITE_` variable:

| Secret | Needed for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | assistant | https://console.anthropic.com |
| `ASSISTANT_DEFAULT_MODEL` | optional | model id; per-org override in `organization_settings.ai_model` |
| `ASSISTANT_MESSAGES_PER_MINUTE` | optional | per-user rate limit, default 12 |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Gmail, Calendar | see below |
| `GOOGLE_OAUTH_REDIRECT_URI` | Gmail, Calendar | `https://<project-ref>.supabase.co/functions/v1/google-oauth-callback` |
| `MICROSOFT_OAUTH_CLIENT_ID` / `MICROSOFT_OAUTH_CLIENT_SECRET` / `MICROSOFT_OAUTH_REDIRECT_URI` / `MICROSOFT_OAUTH_TENANT` (optional) | Outlook mail, calendar | Entra app registration: see DEPLOYMENT.md → Microsoft |
| `RESEND_API_KEY` / `NOTIFY_FROM_EMAIL` | e-mail notifications, invitations | optional; see DEPLOYMENT.md → Notifications |
| `TOKEN_ENCRYPTION_KEY` | Gmail, Outlook, Calendar, Slack/Teams webhooks | 32 random bytes, base64: `openssl rand -base64 32`. **Back it up**; losing it means every user must reconnect. Rotating it invalidates stored tokens. |
| `APP_URL` | OAuth redirect, CORS | e.g. `https://app.example.com` |
| `CRON_SECRET` | workflows | long random string; the scheduler sends it in `x-cron-secret`: `openssl rand -hex 32` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

Deploy: `supabase functions deploy assistant-chat assistant-approve oauth-start google-oauth-callback microsoft-oauth-callback integration-disconnect provider-data document-process workflow-save workflow-run workflow-tick notification-channels invite-member export-org-data delete-account usage-summary`
(`supabase/config.toml` already sets `verify_jwt = false` for the two OAuth callbacks and the scheduler tick only; it is authenticated by an HMAC-signed `state`).

## Scheduler for workflows (pg_cron)
Scheduled and event-triggered workflows are started by a once-a-minute call to the `workflow-tick` function.
1. Database → Extensions: enable **pg_cron**, **pg_net** (and **supabase_vault**).
2. Set the `CRON_SECRET` function secret, then store the same value in Vault and run `supabase/cron.example.sql`
   (replace `<PROJECT_REF>`). Until this is done, scheduled workflows will NOT run; "Run now" still works.
3. Check **Workflows → Recent runs** after the first scheduled time. Ticks tolerate delays up to 5 minutes and
   never double-fire (unique idempotency key per workflow per local minute).

## Google OAuth (Gmail + Calendar)
1. https://console.cloud.google.com → create/select a project.
2. **APIs & Services → Library**: enable *Gmail API* and *Google Calendar API*.
3. **OAuth consent screen**: user type *External*; app name, support email; add scopes
   `openid`, `email`, `.../auth/gmail.readonly`, `.../auth/gmail.compose`, `.../auth/calendar.events`, `.../auth/calendar.freebusy`.
   While the app is in *Testing* only listed test users can connect and refresh tokens expire after 7 days.
   `gmail.readonly`/`gmail.compose` are **restricted scopes**: serving real customers requires Google's app
   verification (and typically a third-party security assessment). Plan for that before launch.
4. **Credentials → Create OAuth client ID → Web application**. Authorized redirect URI = your
   `GOOGLE_OAUTH_REDIRECT_URI`. Copy the client id/secret into the secrets above.
5. In the app: Integrations → Connect. Disconnecting revokes the token at Google and deletes our copy.

## Deployment (frontend)
Vercel: import the repo, set **Root Directory** to `assistant`, framework preset *Vite*, and add
the two `VITE_` variables. Add a rewrite so deep links work:
`vercel.json` → `{ "rewrites": [{ "source": "/(.*)", "destination": "/" }] }` (included).
Backend deployment (edge functions, job runner) is documented per phase as it is built.
