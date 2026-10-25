# Aurum Ventura · Document Management System

A multi-tenant document manager for Aurum Ventura's client-facing admin platform:
folders and tags, metadata, filename/metadata search, private file storage, versioning,
expiring share links and an audit trail — on Next.js, Supabase (Postgres, Auth, Storage),
Tailwind and shadcn/ui-style components.

* **Public page (`/`)** – marketing hero plus a fully working **demo workspace** that runs
  the real business logic against in-browser sample data. Nothing is uploaded or saved.
* **App (`/app`)** – the authenticated workspace, with no hero. Requires Supabase.
* **Development mode** – with no Supabase variables (and not in production), `/app` runs on
  server-memory sample data with no login, clearly labelled "Development mode".

## Contents
1. [Quick start (no credentials)](#quick-start-no-credentials)
2. [Supabase setup](#supabase-setup)
3. [Environment variables](#environment-variables)
4. [Architecture and security model](#architecture-and-security-model)
5. [Testing](#testing)
6. [Deployment](#deployment)
7. [Implemented features](#implemented-features)
8. [Limitations and what is not verified](#limitations-and-what-is-not-verified)

## Quick start (no credentials)

```bash
npm install
npm run dev          # http://localhost:3000  (demo)   /app (dev mode)
```

Requires Node 20.19+ (developed on Node 22). Without Supabase variables `/app` uses
in-memory data that resets on restart. In production this mode is refused (the app
fails closed) unless `DMS_ALLOW_DEV_MODE=true`.

## Supabase setup

1. Create a project at supabase.com.
2. **Apply the migrations** in `supabase/migrations/` in order — with the CLI
   (`supabase link --project-ref <ref> && supabase db push`) or by pasting each file into
   the SQL editor. They create the tables, helper functions, RLS policies, RPCs, audit
   triggers, the **private** `documents` bucket and its storage policies.
3. **Auth** (Authentication › URL Configuration): set *Site URL* to your app URL and add
   `https://<your-domain>/auth/callback` (and `http://localhost:3000/auth/callback`) to
   *Redirect URLs*. Email + password sign-in is used; keep "Confirm email" on for production.
4. **Keys** (Project Settings › API): copy the URL and the publishable/anon key into
   `.env.local` (see `.env.example`). Add `SUPABASE_SERVICE_ROLE_KEY` only if you want
   share links; it is read solely by `/share/[token]` on the server.
5. Sign up at `/signup`, then create your workspace on first sign-in. The creator becomes
   `owner` and the five system folders are seeded.
6. **Adding teammates**: owners and admins open **Team** in the workspace header and
   invite by email address. **No email is sent** — tell the person to sign up (or sign in)
   at your app with that exact address. When they do, `/app` calls `dms_accept_invites()`,
   which joins them only if their address is *confirmed* in Supabase Auth, so keep
   "Confirm email" on (with it off, anyone could claim an invite by typing the address).
   Invites expire after 14 days. A person who already has a workspace keeps it as their
   primary one; the new membership exists but there is no workspace switcher yet.
7. **Scheduled cleanup** (recommended): set `CRON_SECRET` (16+ random characters) and
   `SUPABASE_SERVICE_ROLE_KEY`, then call `/api/maintenance/cleanup-uploads` daily — see
   [Deployment](#deployment).

> The bucket limits uploads to 50 MB and a list of MIME types. If you raise
> `DMS_MAX_FILE_SIZE_MB` or add file types, update the bucket row in
> `supabase/migrations/20261023000004_dms_storage.sql` (or the dashboard) too.

## Environment variables

See `.env.example`. Browser-visible: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (RLS protects data). Server-only:
`SUPABASE_SERVICE_ROLE_KEY` (share links and cleanup), `CRON_SECRET` (protects the cleanup
route). Policy knobs: `DMS_PENDING_UPLOAD_MAX_AGE_HOURS` (default 24, minimum 3), `DMS_MAX_FILE_SIZE_MB`,
`DMS_MAX_FILES_PER_BATCH`, `DMS_ALLOWED_EXTENSIONS`, `DMS_EXTRA_FILE_TYPES`,
`DMS_ALLOW_DEV_MODE`.

## Architecture and security model

```
UI components ──► useDocumentManager (state) ──► DmsApi interface
                                                   ├─ http-api  ─► /api/dms/* route handlers ─► DocumentService ─► Supabase adapters
                                                   └─ local-api ─► DocumentService ─► in-memory adapters   (public demo)
```

* `src/lib/dms/service.ts` – all business rules: role checks, upload validation, quota,
  workspace scoping, versioning, share links, audit calls. Pure TypeScript over two ports
  (`DocumentRepository`, `ObjectStorage`), so it is unit-tested without a database.
* `src/lib/dms/supabase/*` – adapters that run **as the signed-in user** (never the service
  role), so Postgres RLS is the tenant boundary. UI filtering is not relied on.
* **Uploads** go browser → Supabase Storage directly via a signed upload URL (no server
  body-size limit). Sequence: `initiate` (server validates name/type/size, atomically
  reserves quota in Postgres, creates a *pending* version) → browser PUT with real progress
  and cancel → `finalize` (server checks the object exists, its size equals what was
  declared, and magic bytes match the extension; otherwise it deletes the object and the
  pending record). Storage RLS only allows creating an object for a pending version the
  caller opened, so quota cannot be bypassed by talking to Storage directly.
* **Downloads/previews** use 60-second signed URLs minted after an authorization check.
  Storage object keys never reach the browser; buckets are never public.
* **Keys** are `<workspace>/<document>/v<n>-<nonce>.<ext>`, built server-side. User file
  names are sanitised for display only and never used in paths.
* **Share links**: 256-bit random token, only its SHA-256 hash is stored, 5 min–7 days,
  resolved by a service-role-only SQL function and redirected to a 60-second signed URL.
  Editors can list a document's live links and revoke their own (admins: any); revocation
  takes effect immediately. Creation, revocation and every *use* of a link are audit-logged
  (a use has no actor, since link holders are anonymous). The URL itself is shown once.
* **Team**: invites and role changes are SECURITY DEFINER RPCs (`workspace_members` and
  `workspace_invites` have no client write grants). Rules, enforced in both the service and
  SQL: admins manage viewers/editors only; only owners grant or touch admin/owner; nobody
  changes their own role or removes themselves; a workspace always keeps one owner (row
  locks serialise concurrent owner changes). Invites match a *confirmed* email only.
* **Abandoned uploads**: `dms_cleanup_stale_uploads()` (service-role only) deletes pending
  versions/documents older than the threshold (≥ 3 h, because signed upload URLs last 2 h)
  and returns their storage keys; the route then deletes the objects and reports counts.
* **Rate limiting**: mutating `/api/dms` requests are limited per signed-in user (120/min),
  with stricter limits on upload initiation (60/min), share-link creation (20/min) and
  invites (20/h); `/share/[token]` is limited per client address (60/min). Exceeding a limit
  returns `429` with `Retry-After`. **The limiter is in memory, per server instance** (see
  limitations).
* **Audit log**: written by database triggers (upload, rename, move, star, category,
  delete/restore/purge, folder changes), by the team/share RPCs themselves (invites, role
  changes, removals, joins, link revocation and use, expired uploads), and by an allow-listed
  RPC (download, share, tags).
  Admins can read it; nobody can edit it. Contents and credentials are never logged.
* **Auth**: `proxy.ts` refreshes the session and gates `/app` and `/api/dms`; handlers
  re-authenticate with `auth.getUser()` (validated server-side). Cross-origin mutations
  are rejected; `next=` redirects are same-site only; API errors are generic.
* **Roles**: viewer (read/download) · editor (+upload, edit, tag, soft-delete, folders,
  share) · admin (+purge, read audit log) · owner.
* Security headers (`nosniff`, `X-Frame-Options: DENY`, referrer/permissions policy) are set
  in `next.config.ts`.

Database layout: `workspaces`, `workspace_members`, `document_folders`, `documents`,
`document_versions` (with `status`), `document_tags`, `document_tag_assignments`,
`audit_logs`, plus `document_share_links`. Child rows use composite foreign keys so they
cannot point into another workspace. `documents.content_text` and a generated
`search_vector` (GIN-indexed) are **reserved** for a future text-extraction pipeline —
nothing populates or queries them today.

## Testing

```bash
npm run typecheck && npm run lint
npm test            # 187 unit/component tests (vitest)
npm run test:db     # migrations + RLS against a throwaway local PostgreSQL 16 (185 PASS checks, including security regressions)
npm run test:e2e    # Playwright: demo page, dev-mode server flows, tablet/phone layout (28 tests)
```

* `tests/unit` – service rules (roles, **workspace isolation**, upload validation,
  download authorization, folder filtering, search, rename/move/star, delete/restore/purge,
  usage and quota), team rules and share-link revocation, validation helpers, proxy/route
  authentication, rate limiting, the share and cleanup routes, **the Supabase adapters**
  (`SupabaseRepository`/`SupabaseStorage` against a recording fake client: RPC arguments,
  column mapping, tenant scoping, error mapping, signed-URL handling), and component tests
  for empty/error/loading states, the workspace flows and the Team dialog.
* `supabase/tests/run.sh` – boots a temporary Postgres 16, stubs Supabase's `auth`/`storage`
  schemas and roles, applies every migration, and exercises RLS as different users
  (cross-workspace reads/writes, role limits, protected columns, storage policies, quota,
  audit triggers, share-link resolution, invites and acceptance incl. unverified/expired/
  wrong-address cases, role/removal rules, link revocation and use auditing, stale-upload
  cleanup). `supabase/tests/team.sql` is included from `rls.sql`. Needs the PostgreSQL 16
  server binaries (`PG_BIN` overrides the path).
* `tests/e2e` – needs a Chromium; set `PLAYWRIGHT_CHROMIUM_PATH` or run
  `npx playwright install chromium`. `layout.spec.ts` checks 820 px and 360 px for page
  overflow, panel fit and touch-target size, and writes screenshots to `test-results/layout/`.
  The first visit to each page compiles it in the dev server, so a cold run is slower.

## Deployment

Any Node host works (Vercel, Fly, Docker, …):

1. Apply the migrations and configure Auth as above.
2. Set the environment variables on the host (do **not** set `DMS_ALLOW_DEV_MODE`).
3. `npm run build && npm start` (Vercel: import the `document-management` directory).
4. Smoke test with **two** accounts in two workspaces: sign up, create workspaces,
   upload, download, preview, share link; confirm account B cannot see account A's
   documents, and that `GET /api/dms/bootstrap` is 401 when signed out.

### Scheduling the upload cleanup

`GET|POST /api/maintenance/cleanup-uploads` removes abandoned pending uploads. It needs
`CRON_SECRET` (≥ 16 characters) and `SUPABASE_SERVICE_ROLE_KEY`, and authenticates with
`Authorization: Bearer <CRON_SECRET>` (or an `x-cron-secret` header). It responds with
counts only. The route is outside `/api/dms`, so it is not behind user login — the secret is
the only gate; without `CRON_SECRET` it returns 503.

* **Vercel**: `vercel.json` schedules it daily at 03:17 UTC; Vercel sends the bearer header
  automatically when `CRON_SECRET` is set as a project environment variable.
* **Elsewhere**: `curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://your.app/api/maintenance/cleanup-uploads`
  from any scheduler (cron, GitHub Actions, Supabase `pg_cron` + `pg_net`).

If this directory is moved to its own repo, `supabase/` and `tests/` move with it unchanged.

## Implemented features

Responsive UI (desktop/tablet/mobile) with hero + demo page · folder cards with counts and
filtering · document grid with type icon, size, date, category, tags, star · search
(filename, tags, category, extension, uploader) · category/type/tag filters · sort · All/
Recent/Starred/Trash views · incremental "Load more" · floating upload dialog (drag-and-drop,
browse, validation, per-file progress, cancel, retry, destination folder, storage usage) ·
floating details panel (full-screen on phones) with PDF/image/CSV/text preview and
"download to view" fallback · download · expiring share links · rename · move · category ·
tags · star · optional expiration date · version history, upload new version, download old
versions · soft delete with confirmation, restore, permanent delete · custom folders
(create/rename/delete; system folders protected) · per-workspace storage usage and quota ·
audit log · Supabase auth (sign in/up/out, onboarding) · RLS on every table and the bucket ·
team management (invite by email, change roles, remove members, pending invites; owners/admins
only) · share-link list and revoke, with creation/revocation/use audited · scheduled cleanup of
abandoned uploads · per-user and per-address rate limiting.

## Limitations and what is not verified

* **Not verified against a hosted Supabase project.** I could not reach one. The SQL is
  tested on a real local Postgres 16 with *stubbed* `auth`/`storage` schemas, so the RLS and
  RPC logic is exercised for real, but Supabase Auth, PostgREST, Storage's signed-URL
  endpoints and the browser→Storage signed upload (the multipart body mirrors
  `@supabase/storage-js`' `uploadToSignedUrl`, checked against its source) have **not** been
  run end to end. `SupabaseRepository`/`SupabaseStorage` are tested against a *fake* client
  (they verify what we ask the database/Storage to do, not how Supabase answers). Run the
  two-account smoke test above before trusting a deployment.
* **Full-text search of document contents is NOT implemented.** Search covers filenames,
  tags, category, extension and uploader. The columns for later text extraction exist but
  are unused, and the UI does not claim content search.
* Mutations are mostly one round trip each; multi-step operations rely on the RPCs (quota
  reservation, completing/aborting uploads, tag replacement, purge, team changes). Deleting
  storage objects after a purge or cleanup is best-effort: a failure leaves an orphaned
  object, never a dangling record, and the cleanup route only *reports* such failures. There
  is no scan for objects that have no database row at all.
* The cleanup route and its schedule are not exercised against a real Supabase project, and
  nothing triggers it by itself: you must schedule it.
* Signed upload URLs are valid for Supabase's fixed 2 hours.
* **Rate limiting is in memory and per server instance.** On a multi-instance or serverless
  deployment each instance counts separately (effective limit = limit × instances) and
  counters reset on restart. It blunts loops and casual abuse; it is not a hard guarantee.
  Use a CDN/WAF or a shared store (e.g. Redis) for that. `create_workspace`, login and
  signup are not limited by this app (Supabase Auth applies its own limits).
* **Team**: invites send no email (the inviter must tell the person); they are matched on a
  *confirmed* address, so this depends on "Confirm email" being on. There is no workspace
  switcher: a user who belongs to several workspaces always opens their oldest one. Users
  cannot leave a workspace, change their own role, or transfer ownership in one step
  (promote a second owner, then have them demote you). The Team UI is hidden from editors and
  viewers. Removing a member does not delete what they uploaded or revoke share links they
  created (an admin can revoke those).
* Share links serve the current version, are limited per client address only in memory, and
  the full URL cannot be shown again after creation. Revocation is by link (no "revoke all
  for this document" button).
* Expiration dates are informational (badge on cards); nothing enforces or notifies.
* Previews: PDF, images, CSV, text only. No dark mode.
* Development mode data is in server memory (lost on restart); seeded sample images have no
  bytes there, so their preview/download reports "not available".
* Styling follows the supplied reference screenshot (glass frame, centred document cards, floating upload and details panels) but is an interpretation, not a pixel match; fonts are Geist, bundled locally.
  Responsive behaviour is checked at 1440, 820, 390 and 360 px in Chromium (Playwright layout
  specs plus a manual look at the screenshots), not across other browsers or real devices;
  there is no visual-regression testing.
* Dependencies were installed at current latest versions (Next 16.4, React 19, Tailwind 4,
  zod 4, Vitest 5); `@hookform/resolvers` is pinned to v5 because v6 fails peer resolution.

## Security

See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for the pre-release review: fixed findings, open items and the deployment requirements it depends on (notably: keep Supabase Auth "Confirm email" on, set `CRON_SECRET`, apply migration `…0006_dms_security_hardening.sql`).
