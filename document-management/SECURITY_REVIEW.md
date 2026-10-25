# Security review

Scope: everything under `document-management/` on branch `claude/document-management-stage-1-2`
(Next.js routes, service layer, Supabase adapters, SQL migrations 1–6, proxy, config). The Python
repo root is out of scope.

Method: manual read of every API route, `proxy.ts`, the auth routes, the service and adapters, and all
SQL (RLS, `SECURITY DEFINER` functions, storage policies), plus `npm audit` and live probes of the
suspected issues. Confirmed Critical/High/Medium findings were fixed with regression tests.

**Not verified against a hosted Supabase project.** Behaviour of Supabase Auth, PostgREST, Storage
(signed upload URL semantics, `storage.objects.metadata`, `Content-Disposition` handling) is
inferred from documentation and the local PostgreSQL harness with stubbed `auth`/`storage` schemas.
See "Needs a hosted project" at the end.

## Summary

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | Medium | Open redirect in `/auth/callback?next=` via tab/newline (`/%09/evil.com`) | Fixed |
| 2 | Medium | Storage-quota bypass: `dms_complete_upload` trusted a caller-supplied size | Fixed |
| 3 | Medium | Share links could be minted with any expiry through the API (7-day cap bypass) | Fixed |
| 4 | Medium | Unlimited self-service workspaces, each with its own default quota | Fixed (cap of 5 owned) |
| 5 | Medium | Operator-configurable upload types could enable HTML/SVG/JS (stored XSS on inline serving) | Fixed (blocklist) |
| 6 | Low | `/auth/signout` accepted cross-site POST (logout CSRF) | Fixed |
| 7 | Low | Origin check tolerated a missing header with `Sec-Fetch-Site: cross-site` | Fixed |
| 8 | Low | File names written directly through the API bypass the sanitiser; used in `Content-Disposition` | Fixed (DB check + re-sanitise) |
| 9 | Low | `create_workspace` stored a client-supplied email on the member row | Fixed |
| 10 | Low | JSON bodies parsed with no size cap | Fixed (256 KB) |
| 11 | Info | Missing HSTS / clickjacking / base-uri / form-action headers | Fixed (see note on CSP) |
| 12–19 | Low/Info | Open, see "Open items" | Open |

No Critical or High findings were confirmed.

## Fixed findings

### 1. Open redirect after sign-in — Medium
`src/lib/safe-redirect.ts` (was lines 2–4); used by `src/app/auth/callback/route.ts:9,13` and `src/components/auth/auth-form.tsx:50`.
`safeNext` rejected `//` and `\` but not tab/CR/LF. The WHATWG URL parser strips those, so
`next=/%09/evil.com` → `new URL("/\t/evil.com", origin)` → `https://evil.com`. Reproduced with Node before the fix.
Exploit: attacker sends a victim a callback link carrying a valid code (e.g. their own) and a hostile `next`;
the victim is signed in (login CSRF) and bounced to a phishing page that looks like the post-login screen.
Fix: accept only visible ASCII, no backslash, no leading `//`, and confirm by parsing that the result stays on the
same origin; return the re-serialised path. Tests: `tests/unit/security.test.ts` (14 hostile inputs + a 3,000-case fuzz).

### 2. Storage quota bypass in `dms_complete_upload` — Medium
`supabase/migrations/…0003_dms_functions.sql:185-206` (replaced in `…0006_dms_security_hardening.sql`).
The function wrote the **caller-supplied** `p_size` into `document_versions` / `documents` and never looked at the
stored object. Quota is checked against the size *declared* at `dms_begin_upload`. An editor calling the RPC directly could
declare 1 byte, upload a 50 MB object (the bucket only enforces a per-object limit), then complete with `p_size = 1`,
repeating without ever consuming quota. The app's own `finalizeUpload` compared sizes, but the database did not.
Fix: the function now ignores `p_size`/`p_mime`, requires the object to exist in `storage.objects`, and requires its stored
size to equal the declared (quota-checked) size. SQL tests: object missing, size mismatch, lying `p_size`, version stays pending.

### 3. Share-link lifetime cap bypass — Medium
`supabase/migrations/…0002_dms_rls.sql:105-106` (insert policy), `src/lib/dms/supabase/repository.ts:293`.
The 7-day cap lived only in the service layer; the table accepts client inserts, so an editor could insert a link row
with `expires_at` 100 years out (and arbitrary `created_at`/`revoked_at`), creating a permanent public URL to a
client document that outlives the member's access.
Fix: `BEFORE INSERT` trigger `dms_share_links_guard` (for the `authenticated` role) forces `created_at = now()`, clears
`revoked_at`, and rejects `expires_at` beyond 7 days. SQL tests cover 30 days, "never", exactly 7 days, forged timestamps.

### 4. Unlimited workspaces → unlimited quota — Medium
`supabase/migrations/…0003_dms_functions.sql:110-131`.
Any authenticated user could call `create_workspace` repeatedly, each workspace getting the default 5 GB quota.
Fix: a user may own at most 5 workspaces (`workspace_limit`, mapped to a friendly error). Product decision to confirm:
the number, and whether self-created workspaces should get a smaller default quota than paid ones.

### 5. Active-content file types could be enabled by configuration — Medium
`src/lib/dms/config.ts` (`DMS_EXTRA_FILE_TYPES`).
An operator (or a mistake) adding `html=text/html` or `svg=image/svg+xml` would let users store files that execute script
when opened inline (the dev download route serves same-origin; Supabase serves from its storage origin).
Fix: `BLOCKED_EXTENSIONS` / `BLOCKED_MIME_PATTERNS` are applied to extra types and cannot be overridden by env. The default allow-list
(pdf, docx, xlsx, pptx, csv, jpg, jpeg, png, txt) is also asserted to contain none. Note the storage bucket's own
`allowed_mime_types` (migration 4) already fails closed for any type not listed there.

### 6–7. Cross-site request handling — Low
`src/app/auth/signout/route.ts` had no origin check, and `sameOrigin()` (`src/lib/dms/server/respond.ts`) allowed a request with no
`Origin` even when the browser said `Sec-Fetch-Site: cross-site`. JSON-only bodies are required and `@supabase/ssr` cookies are expected to be `SameSite=Lax`
(unverified, see the last section), so exploitability was low; both now reject cross-site requests, and sign-out reuses the same check.

### 8. File names bypassing the sanitiser — Low
Editors can `PATCH` `documents.display_name` through PostgREST directly. That value reaches `Content-Disposition` via the
signed-URL `download` option (`src/lib/dms/supabase/storage.ts`, `src/app/share/[token]/route.ts`).
Fix: `NOT VALID` CHECK constraints reject control characters and `/` `\` in `display_name`/`original_name` for new and updated
rows, and both download paths re-sanitise the name. (Run `ALTER TABLE … VALIDATE CONSTRAINT` after cleaning any legacy rows.)

### 9–10. Smaller hardening — Low
`create_workspace` now reads the member email from `auth.users` instead of a client argument (spoofed emails could confuse the
"already a member" check and the team list). `readJson` refuses bodies over 256 KB before parsing.

### 11. Headers — Info
Added `Strict-Transport-Security`, `Cross-Origin-Opener-Policy`, and a CSP limited to `frame-ancestors 'none'; base-uri 'self';
form-action 'self'; object-src 'none'`. A full `script-src` policy needs per-request nonces with this Next version and was
not attempted; React escapes all file-derived text and there is no `dangerouslySetInnerHTML`/`innerHTML` in `src/`.

## Reviewed and found sound

- **Authn on every route.** All `/api/dms/*` handlers run through `route()` → `getDms()` → `auth.getUser()` (validated with the auth
  server, not just the cookie); `proxy.ts` additionally 401s unauthenticated `/api/dms` calls. Dev routes return 404 unless dev mode is
  allowed, which requires Supabase to be unconfigured and `NODE_ENV !== "production"` (or an explicit `DMS_ALLOW_DEV_MODE=true`).
- **Tenant isolation.** The workspace id is derived server-side from the caller's membership, never from the request. Every repository
  query is scoped by workspace *and* runs as the user, so RLS applies. All helper/RPC functions are `search_path = ''`; `SECURITY DEFINER`
  functions check roles explicitly; cross-workspace composite FKs prevent a row referencing another workspace's folder/document/tag.
  Grants: `anon` has no table privileges; sensitive RPCs (`dms_resolve_share`, `dms_cleanup_stale_uploads`, `dms_audit_write`) are
  `service_role`/internal only.
- **Storage.** Keys are generated by the database from validated parts (`<ws>/<doc>/v<n>-<nonce>.<ext>`), so path traversal is impossible;
  the insert policy only allows an object for a pending version the caller opened; ready objects cannot be deleted or overwritten
  (no update policy), which closes the finalize TOCTOU for the content that was verified.
- **Invites and roles.** Acceptance requires `email_confirmed_at`; admins cannot create/modify/remove admins or owners; no self role
  change; last-owner rule serialised with row locks.
- **Share links.** 256-bit random token, only the SHA-256 is stored, 60-second signed redirect, `no-referrer`, revocation and
  use auditing, service-role key used only in `/share/[token]` and the cleanup route and never imported by client code.
- **Cleanup route.** Constant-time comparison (hashes both sides), requires a ≥16-character `CRON_SECRET`, fails closed if unset.
- **Logging.** Only error class names and Postgres error codes are logged; no file names, tokens or document contents.
- **Dependencies.** `npm audit` reports 0 vulnerabilities (prod and dev).
- **DoS bounds.** Page size ≤ 100 (zod and SQL), search ≤ 100 chars, tags ≤ 20 per document, per-user rate limits on writes, uploads, shares, invites.

## Open items (not fixed)

| # | Sev | Item | Why / mitigation |
|---|-----|------|------------------|
| 12 | Low | Rate limiting is in memory per instance and the public-share limiter keys on the first `X-Forwarded-For` entry, which a client can spoof on hosts that append rather than overwrite it. | Tokens are 256-bit so guessing is infeasible; the limiter only blunts noise. Needs a shared limiter (CDN/WAF/Redis) for a hard guarantee. |
| 13 | Low | Guard bypass relies on a transaction-local GUC (`dms.rpc`). Safe today because PostgREST cannot run `set_config`, but any future SQL-executing RPC would defeat it. | Design hardening; do not add RPCs that execute caller-supplied SQL. |
| 14 | Low | Editors can still edit `uploaded_by_name`, `category`, `starred` etc. directly, and pass `p_user_name` to `dms_begin_upload`, so the "uploaded by" label is spoofable (the real `uploaded_by` uuid and audit actor are not). | Integrity of a display label; fix by reading the name from `workspace_members` in the RPC. |
| 15 | Low | An editor can create many pending uploads that reserve quota until the 24 h cleanup (rate-limited at 60/min). | Insider self-DoS of shared quota; lower `DMS_PENDING_UPLOAD_MAX_AGE_HOURS` or add a per-user pending cap. |
| 16 | Low | Share links outlive the member who created them; removing a member does not revoke their links. | By design (links are workspace assets); admins can revoke from the document panel. Consider auto-revoking on member removal. |
| 17 | Low | Finalize compares size and magic bytes but not the stored `Content-Type` against the extension; a `.png` could be stored as `application/pdf` (both allowed by the bucket). | No script-capable type is allowed, so impact is a mislabelled download. |
| 18 | Info | CSV/Excel "formula injection" if a downloaded CSV is opened in a spreadsheet. | Content is the uploader's own; out of scope for storage. |
| 19 | Info | No CSP `script-src`. | See finding 11. |

## Deployment requirements this review depends on

- Supabase Auth **"Confirm email" must stay enabled**; otherwise anyone can sign up with an invited address and be auto-joined.
- Set `CRON_SECRET` (≥16 chars); keep `SUPABASE_SERVICE_ROLE_KEY` server-side only and never prefix it `NEXT_PUBLIC_`.
- Apply migration `20261023000006_dms_security_hardening.sql`, then validate the new CHECK constraints.
- Do not set `DMS_ALLOW_DEV_MODE=true` in production.

## Needs a hosted project to verify

1. `storage.objects.metadata->>'size'` is populated for objects uploaded through signed upload URLs (migration 6 depends on it).
2. A signed upload URL cannot be replayed to overwrite an existing object (we rely on `upsert` being off and no update policy).
3. How Supabase Storage renders the `download=` name in `Content-Disposition` for unusual names.
4. Auth cookie attributes (`SameSite`, `Secure`) set by `@supabase/ssr` in production.
5. End-to-end behaviour of every RLS policy through real PostgREST (the harness exercises them at the SQL layer only).
