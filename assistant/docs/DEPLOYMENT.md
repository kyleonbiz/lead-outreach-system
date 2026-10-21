# Deployment

Two deployable parts: the **frontend** (Vercel, static) and the **backend** (Supabase: Postgres, Auth, Storage, Edge Functions, pg_cron).
Do the steps in order; each ends with a check.

## 0. What you need
| Account | Why | Cost note |
|---|---|---|
| Supabase | database, auth, storage, functions, scheduler | Free tier works for a pilot; pg_cron + Vault are available on all plans |
| Vercel | frontend hosting | Hobby tier is fine for a pilot |
| Anthropic | the assistant, summaries, briefings | pay per token; see "Cost controls" |
| Google Cloud | Gmail + Calendar OAuth | free; Gmail scopes need Google verification for public use |

## 1. Supabase project
1. Create the project; note the **project ref**, **URL**, **anon key**. Keep the **service_role key** secret.
2. Apply migrations: `supabase link --project-ref <ref> && supabase db push` (applies every file in `supabase/migrations`, currently `0001`…`0011`, in order).
3. **Check:** SQL editor → `select count(*) from information_schema.tables where table_schema='public'` returns 25+; and as a test,
   `select * from public.integration_credentials` using the anon key must fail with *permission denied* (it is closed to every client role).
4. Authentication → Providers → Email: keep **Confirm email** ON. URL Configuration: Site URL = your Vercel URL; add it and
   `http://localhost:5173` to Redirect URLs. Configure SMTP (Supabase's built-in mailer is rate-limited and for testing only).

## 2. Edge Function secrets
```bash
supabase secrets set \
  ANTHROPIC_API_KEY=... \
  APP_URL=https://<your-vercel-domain> \
  GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... \
  GOOGLE_OAUTH_REDIRECT_URI=https://<ref>.supabase.co/functions/v1/google-oauth-callback \
  TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  CRON_SECRET=$(openssl rand -hex 32)
```
Optional, for **e-mail notifications**: `RESEND_API_KEY` and `NOTIFY_FROM_EMAIL` (see *Notifications* below). Without them, e-mails are
recorded as *skipped* in Settings → Recent deliveries (never silently dropped); in-app, Slack and Teams notifications still work.
Optional: `ASSISTANT_DEFAULT_MODEL`, `ASSISTANT_MESSAGES_PER_MINUTE` (default 12), `ASSISTANT_DAILY_TOKEN_LIMIT` (per org, default 500000, `0` = unlimited).
**Back up `TOKEN_ENCRYPTION_KEY` in a password manager.** If it is lost, every connected Google account must be reconnected.
`APP_URL` also sets the CORS origin; leave it unset only in local development (it then allows `*`).

## 3. Deploy functions
```bash
cd assistant
supabase functions deploy assistant-chat assistant-approve oauth-start google-oauth-callback microsoft-oauth-callback \
  integration-disconnect provider-data document-process workflow-save workflow-run workflow-tick notification-channels invite-member export-org-data delete-account
```
`supabase/config.toml` marks `google-oauth-callback` and `workflow-tick` as `verify_jwt = false` (they authenticate with a signed
OAuth `state` and the `CRON_SECRET` respectively). Every other function requires a valid user JWT **and** re-checks organization
membership server-side.
**Check:** `curl -i -X POST https://<ref>.supabase.co/functions/v1/workflow-tick` → `401` (no secret) — not `200`.

## 4. Scheduler
Enable `pg_cron`, `pg_net`, `supabase_vault`; store the secret and schedule the tick using `supabase/cron.example.sql`.
**Check:** `select * from cron.job_run_details order by start_time desc limit 5` shows `succeeded` each minute.

### Notifications (e-mail, Slack, Teams)
* **How it works:** anything that creates an in-app notification (workflow failure, approval needed, overdue tasks) is queued for delivery by a
  database trigger; the minute-by-minute `workflow-tick` sends it. No extra cron job is needed — if the scheduler is not running, nothing is delivered.
* **E-mail:** create a Resend account, verify a sending domain, then `supabase secrets set RESEND_API_KEY=... NOTIFY_FROM_EMAIL="Aide <notifications@yourdomain.com>"`.
  E-mails go only to each member's own **confirmed** sign-in address, and each person chooses what they get in Settings.
* **Slack / Teams:** an owner or admin adds a channel in Settings → *Slack & Microsoft Teams*. Slack: Incoming Webhooks app. Teams: a channel Workflow
  "Post to a channel when a webhook request is received" (or a legacy `*.webhook.office.com` connector). Only these provider hosts are accepted, over https.
  The URL is encrypted with `TOKEN_ENCRYPTION_KEY` and never shown again. Use **Send test** to confirm it works.
* **Check:** Send test on a channel → message appears; Settings → Recent deliveries shows `sent`.

### Team invitations
* Owners invite from Settings → **Team** (members or admins; owners are made by promoting a member). The `invite-member` function generates a 256-bit token,
  stores **only its SHA-256**, and e-mails `APP_URL/invite/<token>` using the same e-mail settings as notifications. If e-mail is not configured the owner is shown the
  link once to share manually, so an invitation is never lost or faked.
* The link works once, for 7 days, and only for a signed-in user whose **confirmed** e-mail equals the invited address. Keep **Confirm email** ON in Supabase Auth,
  otherwise an unconfirmed sign-up could claim an address it does not control (the database refuses unconfirmed addresses regardless).
* **Check:** invite a second address → open the link in a private window → sign up with that address → confirm the e-mail → you land in the team. Opening the same link again must fail.

## 5. Google OAuth client
See SETUP.md → *Google OAuth*. Authorized redirect URI must equal `GOOGLE_OAUTH_REDIRECT_URI` exactly.
Until Google verifies the app, only listed *test users* can connect and refresh tokens last 7 days.

### Microsoft (Outlook mail and calendar) — optional
1. Microsoft Entra admin center → **App registrations → New registration**. Name it, choose **Accounts in any organizational directory and personal Microsoft accounts**
   (multi-tenant + personal; use *single tenant* only if every user is in your own tenant, and then set `MICROSOFT_OAUTH_TENANT` to your tenant id).
2. Redirect URI (type **Web**): `https://<ref>.supabase.co/functions/v1/microsoft-oauth-callback`.
3. **API permissions → Microsoft Graph → Delegated**: `User.Read`, `offline_access`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite` (plus `openid`, `email`). All are user-consentable;
   a tenant admin can still restrict them, in which case connecting reports "some permissions were not granted".
4. **Certificates & secrets → New client secret.** Copy the secret **Value** immediately (it is shown once) — not the Secret ID. Secrets expire (max 24 months): put the date in your calendar.
5. `supabase secrets set MICROSOFT_OAUTH_CLIENT_ID=... MICROSOFT_OAUTH_CLIENT_SECRET=... MICROSOFT_OAUTH_REDIRECT_URI=https://<ref>.supabase.co/functions/v1/microsoft-oauth-callback`
   (add `MICROSOFT_OAUTH_TENANT=...` only if not "common"), then deploy `oauth-start` and `microsoft-oauth-callback` (already in the deploy list above).
6. **Check:** Integrations → Connect Outlook Mail → sign in → Email page lists unread mail → "draft a reply" creates a draft in Outlook, sends nothing.
* If an organization connects **both** Gmail and Outlook, the most recently connected working account is used for email (and likewise for calendar); disconnect the other to avoid surprises.
* **Disconnecting Outlook only deletes our copy of the credentials.** Microsoft gives apps no way to revoke a refresh token remotely, so the UI says so and points to
  myapps.microsoft.com / account.microsoft.com/privacy/app-access. Publisher verification (to remove the "unverified" prompt for other tenants) is a separate Microsoft process.

### Data export, ownership transfer and account deletion
* Settings → **Data & privacy**. Owners download a zip of all organization data (tasks and history, document *details*, knowledge base, workflows, approvals, activity log, settings, team,
  usage, notification channels without their URLs, invitations without tokens); owners and admins can download just the audit log (JSON + CSV with spreadsheet-formula protection).
  Exports read with the requester's own token (Row Level Security), are limited to one per organization per 5 minutes, and are recorded in Activity. Very large tables are capped (newest rows kept) and the
  zip says so in `manifest.json` and `README.txt`.
* **Transfer ownership** makes a member an owner and can step the previous owner down to admin; an organization can never be left without an owner.
* **Delete my account** (`delete-account`, uses the service role): requires typing your e-mail, having signed in within the last 15 minutes, transferring ownership of any organization that still has other members,
  and acknowledging every organization that would be deleted with you (those where you are the only member, including their stored files). It disconnects the accounts *you* connected (Google is revoked automatically;
  Microsoft cannot be, see above), removes your e-mail address from the audit-log entries you created, then deletes the account. Each step is idempotent: if one fails nothing further is removed and the request can be repeated.
* **Check (use a throwaway account):** create a second user with its own organization -> Delete my account -> the organization, its files and the user are gone; the first organization is untouched.

## 6. Frontend on Vercel
1. Import the repository; **Root Directory = `assistant`**; framework preset **Vite**; build `npm run build`, output `dist`.
2. Environment variables (Production + Preview): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — **only these two**.
3. `vercel.json` supplies the SPA rewrite and the security headers (CSP without inline scripts/eval, `frame-ancestors 'none'`, HSTS,
   `nosniff`, referrer and permissions policies). The CSP allows `https://*.supabase.co`; if you use a Supabase **custom domain**,
   add it to `connect-src`.
4. **Check:** open the site → sign up → confirm email → onboarding → dashboard. Browser console must show no CSP violations.

## 7. Smoke test in production (15 minutes)
1. Create a task by hand; complete it.  2. Assistant: "create a task to call the accountant tomorrow 10am" → task appears, Activity shows
`tasks.create` succeeded.  3. Assistant: "delete that task" → an **approval card** appears and the task still exists; Approve → task gone.
4. Integrations → Connect Gmail → Email page lists unread mail.  5. Ask "draft a reply to the first urgent email" → a draft appears in Gmail,
**nothing sent**.  6. Documents → upload a `.docx` → status Ready, search finds a phrase.  7. Workflows → Set up daily briefing → Run now → briefing on dashboard.
8. Disconnect Gmail → Google shows the app removed; `integration_credentials` row is gone.

## Cost controls
* Per-user rate limit and per-org **daily token budget** (above) stop runaway spend; both return clear errors in the UI.
* Full-text search uses Postgres (no embedding service). Edge Functions only run when called; the tick processes ≤3 runs/minute.
* Watch usage with `select date_trunc('day', created_at), kind, sum(quantity) from usage_records group by 1,2 order by 1 desc`.

## Operations
* **Logs:** Supabase → Edge Functions → Logs; failures are also in the in-app **Activity** and **Notifications**.
* **Backups:** enable Supabase daily backups (paid) or schedule `pg_dump`. Storage files are not in database backups.
* **Rotating `TOKEN_ENCRYPTION_KEY`:** not seamless — stored tokens become unreadable. Rotate by setting the new key, then asking users to reconnect.
* **Rolling back the frontend:** Vercel → Deployments → Promote a previous deployment. Migrations are forward-only: write a new migration to undo one.
* **Incident: token leak suspected** → revoke the Google OAuth client secret in Google Cloud, rotate `TOKEN_ENCRYPTION_KEY`, delete rows in `integration_credentials`.
* **Incident: runaway workflow** → disable it in Workflows (takes effect for new triggers); to stop in-flight work: `update workflow_runs set status='cancelled' where status in ('queued','running','waiting_approval')`.
