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

## Server-side secrets (needed from Phase 3/4)
Set these as **Supabase Edge Function secrets** (not in `.env.local`, not in Vercel's
browser-exposed variables): `ANTHROPIC_API_KEY`, `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`. See `.env.example` for descriptions.
OAuth configuration steps are added with the Gmail/Calendar integration in Phase 4.

## Deployment (frontend)
Vercel: import the repo, set **Root Directory** to `assistant`, framework preset *Vite*, and add
the two `VITE_` variables. Add a rewrite so deep links work:
`vercel.json` → `{ "rewrites": [{ "source": "/(.*)", "destination": "/" }] }` (included).
Backend deployment (edge functions, job runner) is documented per phase as it is built.
