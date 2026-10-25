-- Regression tests for the security review findings. Included from rls.sql.
\set frank '''00000000-0000-4000-8000-00000000000f'''
reset role;
insert into auth.users (id, email) values (:frank, 'frank@real.test');

-- ------------------------------------------- complete_upload cannot lie about size
select t.as_user(:frank);
select public.create_workspace('Frank Co', 'Frank', 'spoofed@evil.test') as wsf \gset
reset role;
select t.ok('workspace owner email comes from auth, not the client argument',
  (select email from public.workspace_members where workspace_id = :'wsf' and user_id = :frank) = 'frank@real.test');
select t.as_user(:frank);
select public.dms_begin_upload(:'wsf', null, '20000000-0000-4000-8000-000000000001', 'a.pdf', 'a.pdf', null, 'other',
  'application/pdf', 1000, 'frk1', 'pdf', 'Frank') as f1 \gset
select (:'f1'::jsonb -> 'version' ->> 'storage_key') as fkey \gset

select t.fails('complete without an uploaded object is rejected',
  format($q$select public.dms_complete_upload(%L,'20000000-0000-4000-8000-000000000001',1,1000,'application/pdf')$q$, :'wsf'),
  'object_missing');

-- a 50 MB object uploaded against a version declared as 1000 bytes
insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', :'fkey', :frank, '{"size": 52428800}');
select t.fails('size mismatch between object and declaration is rejected',
  format($q$select public.dms_complete_upload(%L,'20000000-0000-4000-8000-000000000001',1,1000,'application/pdf')$q$, :'wsf'),
  'size_mismatch');
select t.fails('lying about the size in p_size does not help either',
  format($q$select public.dms_complete_upload(%L,'20000000-0000-4000-8000-000000000001',1,1,'application/pdf')$q$, :'wsf'),
  'size_mismatch');
select t.ok('the failed completion left the version pending and usage reserved',
  (select status from public.document_versions where document_id = '20000000-0000-4000-8000-000000000001') = 'pending');

-- ------------------------------------------- share link expiry cap
select t.as_user(:frank);
insert into public.documents (id, workspace_id, original_name, display_name, mime_type, size_bytes, status)
  select '20000000-0000-4000-8000-000000000009', :'wsf', 'x.pdf', 'x.pdf', 'application/pdf', 1, 'ready' where false;
reset role;
-- make a ready doc to attach links to (superuser fixture)
insert into public.documents (id, workspace_id, original_name, display_name, mime_type, size_bytes, status, current_version)
  values ('20000000-0000-4000-8000-000000000009', :'wsf', 'x.pdf', 'x.pdf', 'application/pdf', 1, 'ready', 1);
select t.as_user(:frank);
select t.fails('share link longer than 7 days is rejected',
  format($q$insert into public.document_share_links (workspace_id, document_id, token_hash, expires_at, created_by) values (%L,'20000000-0000-4000-8000-000000000009','h-long',now() + interval '30 days',%L)$q$, :'wsf', :frank),
  'invalid_expiry');
select t.fails('share link that never expires is rejected',
  format($q$insert into public.document_share_links (workspace_id, document_id, token_hash, expires_at, created_by) values (%L,'20000000-0000-4000-8000-000000000009','h-forever',now() + interval '100 years',%L)$q$, :'wsf', :frank),
  'invalid_expiry');
select t.affected('share link within 7 days is accepted',
  format($q$insert into public.document_share_links (workspace_id, document_id, token_hash, expires_at, created_by, created_at, revoked_at) values (%L,'20000000-0000-4000-8000-000000000009','h-ok',now() + interval '7 days',%L, now() - interval '400 days', now())$q$, :'wsf', :frank), 1);
select t.ok('client-supplied created_at and revoked_at are overwritten by the server',
  (select created_at > now() - interval '1 minute' and revoked_at is null from public.document_share_links where token_hash = 'h-ok'));

-- ------------------------------------------- file names written directly
select t.fails('display name with a path separator is rejected',
  $q$update public.documents set display_name = '../../etc/passwd' where id = '20000000-0000-4000-8000-000000000009'$q$, 'documents_display_name_safe');
select t.fails('display name with a control character is rejected',
  $q$update public.documents set display_name = E'a\r\nSet-Cookie: x=1.pdf' where id = '20000000-0000-4000-8000-000000000009'$q$, 'documents_display_name_safe');
select t.affected('an ordinary rename still works',
  $q$update public.documents set display_name = 'Q4 report (final).pdf' where id = '20000000-0000-4000-8000-000000000009'$q$, 1);

-- ------------------------------------------- workspace cap
select public.create_workspace('Frank 2', 'Frank', 'x') is not null as ok2 \gset
select public.create_workspace('Frank 3', 'Frank', 'x') is not null as ok3 \gset
select public.create_workspace('Frank 4', 'Frank', 'x') is not null as ok4 \gset
select public.create_workspace('Frank 5', 'Frank', 'x') is not null as ok5 \gset
select t.fails('a sixth owned workspace is refused',
  $q$select public.create_workspace('Frank 6', 'Frank', 'x')$q$, 'workspace_limit');
reset role;
