-- RLS / RPC tests. Run through run.sh. Any failed assertion aborts the run.
\set ON_ERROR_STOP 1
\set QUIET 1
set client_min_messages = notice;

create schema t;
grant usage on schema t to public;
create function t.as_user(u uuid) returns void language plpgsql as $$
begin reset role; perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), false); set role authenticated; end $$;
create function t.as_anon() returns void language plpgsql as $$
begin reset role; perform set_config('request.jwt.claim.sub', '', false); set role anon; end $$;
create function t.ok(name text, cond boolean) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', name; end if;
  raise notice 'PASS: %', name;
end $$;
-- statement must raise; optional substring of the message/sqlstate must match.
create function t.fails(name text, stmt text, expect text default null) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if expect is not null and position(expect in sqlerrm || ' ' || sqlstate) = 0 then
      raise exception 'FAIL: % (wrong error: % / %)', name, sqlstate, sqlerrm;
    end if;
    raise notice 'PASS: %', name;
    return;
  end;
  raise exception 'FAIL: % (statement succeeded)', name;
end $$;
create function t.affected(name text, stmt text, expected integer) returns void language plpgsql as $$
declare n integer;
begin
  execute stmt; get diagnostics n = row_count;
  if n <> expected then raise exception 'FAIL: % (affected %, expected %)', name, n, expected; end if;
  raise notice 'PASS: %', name;
end $$;
create function t.count(stmt text) returns bigint language plpgsql as $$
declare n bigint;
begin execute 'select count(*) from (' || stmt || ') q' into n; return n; end $$;
grant execute on all functions in schema t to public;

\set alice '''00000000-0000-4000-8000-00000000000a'''
\set bob   '''00000000-0000-4000-8000-00000000000b'''
\set carol '''00000000-0000-4000-8000-00000000000c'''
\set dave  '''00000000-0000-4000-8000-00000000000d'''
\set erin  '''00000000-0000-4000-8000-00000000000e'''

insert into auth.users (id, email) values
  (:alice, 'alice@a.test'), (:bob, 'bob@b.test'), (:carol, 'carol@a.test'),
  (:dave, 'dave@a.test'), (:erin, 'erin@a.test');

-- ---------------------------------------------------------------- workspaces
select t.as_user(:alice);
select public.create_workspace('Alpha Co', 'Alice', 'alice@a.test') as wsa \gset
select t.as_user(:bob);
select public.create_workspace('Beta LLC', 'Bob', 'bob@b.test') as wsb \gset

reset role;
insert into public.workspace_members (workspace_id, user_id, role, display_name, email) values
  (:'wsa', :carol, 'viewer', 'Carol', 'carol@a.test'),
  (:'wsa', :dave, 'editor', 'Dave', 'dave@a.test'),
  (:'wsa', :erin, 'admin', 'Erin', 'erin@a.test');

select id as folder_a from public.document_folders where workspace_id = :'wsa' limit 1 \gset
select t.as_user(:alice);
select t.ok('create_workspace seeds 5 system folders',
  (select count(*) from public.document_folders where workspace_id = :'wsa' and is_system) = 5);
select t.ok('owner sees only own workspace', (select count(*) from public.workspaces) = 1);
select t.ok('owner membership row exists', public.dms_role(:'wsa') = 'owner');

-- ---------------------------------------------------------------- upload flow
select public.dms_begin_upload(:'wsa', null, '10000000-0000-4000-8000-000000000001', 'invoice-1.pdf', 'invoice-1.pdf',
  (select id from public.document_folders where workspace_id = :'wsa' and name = 'Invoices'),
  'invoice', 'application/pdf', 1000, 'nonce1', 'pdf', 'Alice') as up1 \gset
select (:'up1'::jsonb -> 'version' ->> 'storage_key') as key1 \gset
select t.ok('begin_upload builds a workspace-prefixed key',
  :'key1' = :'wsa' || '/10000000-0000-4000-8000-000000000001/v1-nonce1.pdf');
select t.ok('pending documents are not listed',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'',null,null,null,'newest',1,10)) = 0);

-- storage insert allowed only for a pending key the caller opened
insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', :'key1', :alice, '{"size": 1000}');
select t.fails('storage insert for an unknown key is denied',
  format($q$insert into storage.objects (bucket_id, name) values ('documents', %L)$q$,
    :'wsa' || '/10000000-0000-4000-8000-0000000000ff/v1-zzz.pdf'), 'row-level security');

select public.dms_complete_upload(:'wsa', '10000000-0000-4000-8000-000000000001', 1, 1000, 'application/pdf');
select t.ok('upload becomes visible after completion',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'',null,null,null,'newest',1,10)) = 1);
select t.ok('usage counts bytes', (public.dms_usage(:'wsa') ->> 'usedBytes')::bigint = 1000);

select t.fails('client cannot insert documents directly',
  format($q$insert into public.documents (workspace_id, original_name, display_name, mime_type, size_bytes) values (%L,'x.pdf','x.pdf','application/pdf',1)$q$, :'wsa'),
  'row-level security');
select t.affected('storage delete of ready object affects 0 rows',
  format($q$delete from storage.objects where name = %L$q$, :'key1'), 0);

-- second document + new version
select public.dms_begin_upload(:'wsa', null, '10000000-0000-4000-8000-000000000002', 'budget.xlsx', 'budget.xlsx',
  null, 'other', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 500, 'nonce2', 'xlsx', 'Alice') as up2 \gset
insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', :'wsa' || '/10000000-0000-4000-8000-000000000002/v1-nonce2.xlsx', :alice, '{"size": 500}');
select public.dms_complete_upload(:'wsa', '10000000-0000-4000-8000-000000000002', 1, 500, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
select public.dms_begin_upload(:'wsa', '10000000-0000-4000-8000-000000000002', null, 'budget.xlsx', 'budget.xlsx',
  null, 'other', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 700, 'nonce3', 'xlsx', 'Alice') as up3 \gset
select t.ok('new version gets number 2', (:'up3'::jsonb -> 'version' ->> 'version_number') = '2');
select t.fails('second pending version for the same document is a conflict',
  format($q$select public.dms_begin_upload(%L,'10000000-0000-4000-8000-000000000002',null,'budget.xlsx','budget.xlsx',null,'other','x',10,'n4','xlsx','A')$q$, :'wsa'), 'conflict');
insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', :'wsa' || '/10000000-0000-4000-8000-000000000002/v2-nonce3.xlsx', :alice, '{"size": 700}');
select public.dms_complete_upload(:'wsa', '10000000-0000-4000-8000-000000000002', 2, 700, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
select t.ok('all versions count toward usage', (public.dms_usage(:'wsa') ->> 'usedBytes')::bigint = 2200);
select t.ok('document points at version 2',
  (select current_version from public.documents where id = '10000000-0000-4000-8000-000000000002') = 2);

-- abort removes a pending doc entirely
select public.dms_begin_upload(:'wsa', null, '10000000-0000-4000-8000-000000000003', 'tmp.png', 'tmp.png',
  null, 'other', 'image/png', 50, 'nonce5', 'png', 'Alice');
select t.ok('abort returns the key', public.dms_abort_upload(:'wsa', '10000000-0000-4000-8000-000000000003', 1) is not null);
select t.ok('aborted document row is gone',
  not exists (select 1 from public.documents where id = '10000000-0000-4000-8000-000000000003'));

-- quota (set as superuser)
reset role; update public.workspaces set storage_quota_bytes = 2300 where id = :'wsa';
select t.as_user(:alice);
select t.fails('quota is enforced atomically',
  format($q$select public.dms_begin_upload(%L,null,'10000000-0000-4000-8000-000000000004','big.pdf','big.pdf',null,'other','application/pdf',200,'n6','pdf','A')$q$, :'wsa'),
  'quota_exceeded');
reset role; update public.workspaces set storage_quota_bytes = 5368709120 where id = :'wsa';

-- ---------------------------------------------------------------- tags + search
select t.as_user(:alice);
select t.ok('set_tags returns names', public.dms_set_tags(:'wsa', '10000000-0000-4000-8000-000000000001', array['Q4','Northwind']) = array['Northwind','Q4']);
select t.ok('tag search finds the document',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'northwind',null,null,null,'newest',1,10)) = 1);
select t.ok('tag filter finds the document',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'',null,null,'q4','newest',1,10)) = 1);
select t.ok('filename search', (select count(*) from public.dms_query_documents(:'wsa','all',null,'budget',null,null,null,'newest',1,10)) = 1);
select t.ok('category label search', (select count(*) from public.dms_query_documents(:'wsa','all',null,'invoice',null,null,null,'newest',1,10)) = 1);
select t.ok('percent is treated literally', (select count(*) from public.dms_query_documents(:'wsa','all',null,'%',null,null,null,'newest',1,10)) = 0);
select t.ok('file type filter excel', (select count(*) from public.dms_query_documents(:'wsa','all',null,'',null,'excel',null,'newest',1,10)) = 1);
select t.ok('folder filter', (select count(*) from public.dms_query_documents(:'wsa','all',
  (select id from public.document_folders where workspace_id = :'wsa' and name = 'Invoices'),'',null,null,null,'newest',1,10)) = 1);
select t.ok('pagination reports total',
  (select max(total) from public.dms_query_documents(:'wsa','all',null,'',null,null,null,'name-asc',1,1)) = 2);
select t.ok('tags are replaced', public.dms_set_tags(:'wsa', '10000000-0000-4000-8000-000000000001', array['Q4']) = array['Q4']);

-- ---------------------------------------------------------------- isolation (bob in workspace B)
select t.as_user(:bob);
select t.ok('bob sees only workspace B', (select count(*) from public.workspaces) = 1 and (select id from public.workspaces) = :'wsb'::uuid);
select t.ok('bob cannot read A documents', (select count(*) from public.documents where workspace_id = :'wsa') = 0);
select t.ok('bob cannot read A folders', (select count(*) from public.document_folders where workspace_id = :'wsa') = 0);
select t.ok('bob cannot read A versions', (select count(*) from public.document_versions) = 0);
select t.ok('bob cannot read A tags', (select count(*) from public.document_tags) = 0);
select t.ok('bob query_documents on A is empty',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'',null,null,null,'newest',1,10)) = 0);
select t.ok('bob sees zero usage for A', (public.dms_usage(:'wsa') ->> 'usedBytes')::bigint = 0);
select t.fails('bob cannot begin an upload in A',
  format($q$select public.dms_begin_upload(%L,null,'10000000-0000-4000-8000-000000000009','x.pdf','x.pdf',null,'other','application/pdf',10,'n7','pdf','B')$q$, :'wsa'), 'forbidden');
select t.fails('bob cannot complete an A upload', format($q$select public.dms_complete_upload(%L,'10000000-0000-4000-8000-000000000001',1,1000,'application/pdf')$q$, :'wsa'));
select t.affected('bob cannot update A documents', format($q$update public.documents set starred = true where workspace_id = %L$q$, :'wsa'), 0);
select t.affected('bob cannot delete A documents', format($q$delete from public.documents where workspace_id = %L$q$, :'wsa'), 0);
select t.fails('bob cannot insert a folder into A',
  format($q$insert into public.document_folders (workspace_id, name, created_by) values (%L,'Evil',%L)$q$, :'wsa', :bob), 'row-level security');
select t.fails('bob cannot set tags on A docs', format($q$select public.dms_set_tags(%L,'10000000-0000-4000-8000-000000000001',array['x'])$q$, :'wsa'), 'not_found');
select t.fails('bob cannot write audit rows for A', format($q$select public.dms_record_audit(%L,'document.downloaded','10000000-0000-4000-8000-000000000001','{}')$q$, :'wsa'), 'forbidden');
select t.ok('bob cannot read A audit logs', (select count(*) from public.audit_logs where workspace_id = :'wsa') = 0);
select t.ok('bob cannot read A storage objects', (select count(*) from storage.objects) = 0);
select t.fails('bob cannot create a storage object under A',
  format($q$insert into storage.objects (bucket_id, name) values ('documents', %L)$q$, :'key1'), 'row-level security');
select t.fails('bob cannot purge A documents', format($q$select public.dms_purge_document(%L,'10000000-0000-4000-8000-000000000001')$q$, :'wsa'), 'not_found');

-- cross-workspace folder reference is rejected by the composite FK
select t.fails('B document cannot reference an A folder',
  format($q$select public.dms_begin_upload(%L,null,'10000000-0000-4000-8000-000000000008','x.pdf','x.pdf',%L,'other','application/pdf',10,'n8','pdf','B')$q$,
    :'wsb', :'folder_a'), 'foreign key');

-- ---------------------------------------------------------------- anon
select t.as_anon();
select t.fails('anon cannot read documents', 'select * from public.documents', 'permission denied');
select t.fails('anon cannot read workspaces', 'select * from public.workspaces', 'permission denied');
select t.fails('anon cannot call create_workspace', $q$select public.create_workspace('Nope Inc','a','a')$q$, 'permission denied');

-- ---------------------------------------------------------------- roles inside workspace A
select t.as_user(:carol);  -- viewer
select t.ok('viewer can read documents', (select count(*) from public.documents where workspace_id = :'wsa') >= 2);
select t.affected('viewer cannot update documents', format($q$update public.documents set starred = true where workspace_id = %L$q$, :'wsa'), 0);
select t.fails('viewer cannot begin upload', format($q$select public.dms_begin_upload(%L,null,'10000000-0000-4000-8000-00000000000f','x.pdf','x.pdf',null,'other','application/pdf',10,'n9','pdf','C')$q$, :'wsa'), 'forbidden');
select t.fails('viewer cannot create folders', format($q$insert into public.document_folders (workspace_id, name, created_by) values (%L,'V',%L)$q$, :'wsa', :carol), 'row-level security');
select t.ok('viewer cannot read audit logs', (select count(*) from public.audit_logs where workspace_id = :'wsa') = 0);
select public.dms_record_audit(:'wsa','document.downloaded','10000000-0000-4000-8000-000000000001','{"version":1}');
select t.fails('arbitrary audit actions are rejected', format($q$select public.dms_record_audit(%L,'document.purged','10000000-0000-4000-8000-000000000001','{}')$q$, :'wsa'), 'invalid_action');
select t.ok('viewer can read storage objects of own workspace', (select count(*) from storage.objects where name = :'key1') = 1);

select t.as_user(:dave);  -- editor
select t.affected('editor can star', format($q$update public.documents set starred = true where id = '10000000-0000-4000-8000-000000000001'$q$), 1);
select t.affected('editor can rename', $q$update public.documents set display_name = 'inv-2041.pdf' where id = '10000000-0000-4000-8000-000000000001'$q$, 1);
select t.fails('editor cannot change size_bytes', $q$update public.documents set size_bytes = 1 where id = '10000000-0000-4000-8000-000000000001'$q$, 'protected_column');
select t.fails('editor cannot mark pending doc ready / change status', $q$update public.documents set status = 'pending' where id = '10000000-0000-4000-8000-000000000001'$q$, 'protected_column');
select t.fails('editor cannot move a document to another workspace', format($q$update public.documents set workspace_id = %L where id = '10000000-0000-4000-8000-000000000001'$q$, :'wsb'));
select t.affected('editor can soft delete', $q$update public.documents set deleted_at = now() where id = '10000000-0000-4000-8000-000000000002'$q$, 1);
select t.affected('editor cannot hard delete', $q$delete from public.documents where id = '10000000-0000-4000-8000-000000000002'$q$, 0);
select t.fails('editor cannot purge', format($q$select public.dms_purge_document(%L,'10000000-0000-4000-8000-000000000002')$q$, :'wsa'), 'not_found');
select t.affected('editor can create custom folder', format($q$insert into public.document_folders (workspace_id, name, created_by) values (%L,'Clients',%L)$q$, :'wsa', :dave), 1);
select t.affected('editor cannot rename system folders', $q$update public.document_folders set name = 'Hacked' where is_system$q$, 0);
select t.affected('editor cannot delete system folders', $q$delete from public.document_folders where is_system$q$, 0);
select t.fails('editor cannot flip is_system', $q$update public.document_folders set is_system = true where name = 'Clients'$q$);
select t.ok('trash view lists the deleted document',
  (select count(*) from public.dms_query_documents(:'wsa','trash',null,'',null,null,null,'newest',1,10)) = 1);
select t.affected('editor can restore', $q$update public.documents set deleted_at = null where id = '10000000-0000-4000-8000-000000000002'$q$, 1);
select t.affected('editor soft-deletes again', $q$update public.documents set deleted_at = now() where id = '10000000-0000-4000-8000-000000000002'$q$, 1);

select t.as_user(:erin);  -- admin
select t.ok('admin can purge a trashed document', array_length(public.dms_purge_document(:'wsa','10000000-0000-4000-8000-000000000002'), 1) = 2);
select t.fails('admin cannot purge a live document', format($q$select public.dms_purge_document(%L,'10000000-0000-4000-8000-000000000001')$q$, :'wsa'), 'not_found');
select t.ok('purge cascades versions', (select count(*) from public.document_versions where document_id = '10000000-0000-4000-8000-000000000002') = 0);
select t.ok('usage drops after purge', (public.dms_usage(:'wsa') ->> 'usedBytes')::bigint = 1000);

-- audit trail written by triggers
select t.ok('admin can read audit logs', (select count(*) from public.audit_logs where workspace_id = :'wsa') > 0);
select t.ok('upload audited', exists (select 1 from public.audit_logs where action = 'document.uploaded' and entity_id = '10000000-0000-4000-8000-000000000001'));
select t.ok('version upload audited', exists (select 1 from public.audit_logs where action = 'document.version_uploaded'));
select t.ok('rename audited with actor', exists (select 1 from public.audit_logs where action = 'document.renamed' and actor_id = :dave));
select t.ok('star audited', exists (select 1 from public.audit_logs where action = 'document.starred'));
select t.ok('delete + restore audited', exists (select 1 from public.audit_logs where action = 'document.deleted') and exists (select 1 from public.audit_logs where action = 'document.restored'));
select t.ok('purge audited', exists (select 1 from public.audit_logs where action = 'document.purged'));
select t.ok('folder creation audited', exists (select 1 from public.audit_logs where action = 'folder.created'));
select t.ok('download audited via RPC', exists (select 1 from public.audit_logs where action = 'document.downloaded' and actor_id = :carol));
select t.ok('audit rows cannot be inserted directly',
  (select true from (select 1) _ where not has_table_privilege('authenticated', 'public.audit_logs', 'insert')));
select t.fails('audit rows cannot be modified', $q$update public.audit_logs set action = 'x'$q$, 'permission denied');

-- share links
select t.as_user(:dave);
insert into public.document_share_links (workspace_id, document_id, token_hash, expires_at, created_by)
  values (:'wsa', '10000000-0000-4000-8000-000000000001', 'hash-ok', now() + interval '1 hour', :dave),
         (:'wsa', '10000000-0000-4000-8000-000000000001', 'hash-expired', now() - interval '1 hour', :dave);
select t.fails('authenticated users cannot resolve share tokens', $q$select * from public.dms_resolve_share('hash-ok')$q$, 'permission denied');
select t.as_user(:bob);
select t.ok('bob cannot see A share links', (select count(*) from public.document_share_links) = 0);
select t.fails('bob cannot create a share link for A', format($q$insert into public.document_share_links (workspace_id, document_id, token_hash, expires_at, created_by) values (%L,'10000000-0000-4000-8000-000000000001','h2',now() + interval '1 day',%L)$q$, :'wsa', :bob), 'row-level security');
reset role; set role service_role;
select t.ok('service role resolves a valid token', (select count(*) from public.dms_resolve_share('hash-ok')) = 1);
select t.ok('expired tokens do not resolve', (select count(*) from public.dms_resolve_share('hash-expired')) = 0);
select t.ok('unknown tokens do not resolve', (select count(*) from public.dms_resolve_share('nope')) = 0);

reset role;
\ir team.sql
reset role;
\ir hardening.sql
reset role;
\ir content.sql
reset role;
\echo ALL RLS TESTS PASSED
