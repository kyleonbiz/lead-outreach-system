\o /dev/null
begin;
create schema if not exists t;
grant usage on schema t to authenticated, anon, service_role;
create or replace function t.ok(cond boolean, name text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FAIL: %', name; end if; raise notice 'ok - %', name; end $$;
create or replace function t.throws(sql text, name text, expected_state text default null) returns void language plpgsql as $$
declare st text;
begin
  begin execute sql;
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    if expected_state is not null and st <> expected_state then raise exception 'FAIL: % (expected %, got % : %)', name, expected_state, st, sqlerrm; end if;
    raise notice 'ok - % [%]', name, st; return;
  end;
  raise exception 'FAIL: % (succeeded but must be rejected)', name;
end $$;
create or replace function t.cnt(sql text) returns bigint language plpgsql as $$
declare n bigint; begin execute 'select count(*) from (' || sql || ') q' into n; return n; end $$;
create or replace function t.as_user(uid uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', uid::text, true); execute 'reset role'; execute 'set local role authenticated'; end $$;
create or replace function t.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', true); execute 'reset role'; execute 'set local role service_role'; end $$;

insert into auth.users (id, email) values
  ('aaaaaaaa-3000-0000-0000-000000000001', 'a@a.test'), ('bbbbbbbb-3000-0000-0000-000000000002', 'b@b.test'),
  ('cccccccc-3000-0000-0000-000000000003', 'c@a.test');
create temp table ctx(k text primary key, v uuid);
grant all on ctx to authenticated, service_role;
select t.as_user('aaaaaaaa-3000-0000-0000-000000000001');
insert into ctx select 'A', public.create_organization('Org A');
insert into public.organization_members (org_id, user_id, role) select v, 'cccccccc-3000-0000-0000-000000000003', 'member' from ctx where k='A';
select t.as_user('bbbbbbbb-3000-0000-0000-000000000002');
insert into ctx select 'B', public.create_organization('Org B');

-- Org A: a policy in the KB, an uploaded doc with chunks
select t.as_user('aaaaaaaa-3000-0000-0000-000000000001');
insert into public.knowledge_base_sources (org_id, kind, title, content)
  select v, 'policy', 'Refund policy', 'Customers may request a refund within 30 days of purchase with a receipt.' from ctx where k='A';
insert into public.documents (id, org_id, name, storage_path, mime_type)
  select 'dddddddd-0000-4000-8000-000000000001', v, 'Service agreement.docx', v::text || '/dddddddd/agreement.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' from ctx where k='A';
select t.as_service();
insert into public.document_chunks (org_id, document_id, chunk_index, content)
  select v, 'dddddddd-0000-4000-8000-000000000001', 0, 'The contractor shall deliver the final report by December 15, 2026. Late payment incurs a 2% monthly fee.' from ctx where k='A';
-- Org B: same words, secret
select t.as_user('bbbbbbbb-3000-0000-0000-000000000002');
insert into public.knowledge_base_sources (org_id, kind, title, content)
  select v, 'policy', 'B refund secret', 'Org B refund policy: secret formula payment terms.' from ctx where k='B';

-- search works for members, ranks, returns snippets
select t.as_user('cccccccc-3000-0000-0000-000000000003');
select t.ok(t.cnt($q$select 1 from public.search_knowledge((select v from ctx where k='A'), 'refund policy', 5)$q$) = 1, 'member finds the knowledge entry');
select t.ok(t.cnt($q$select 1 from public.search_knowledge((select v from ctx where k='A'), 'late payment fee', 5) where source='document'$q$) = 1, 'member finds document chunk text');
select t.ok((select snippet from public.search_knowledge((select v from ctx where k='A'), 'refund', 5) limit 1) like '%<b>%', 'snippet highlights matches');
select t.ok(t.cnt($q$select 1 from public.search_knowledge((select v from ctx where k='A'), 'xyzzy nothing', 5)$q$) = 0, 'no match -> no rows');
select t.ok(t.cnt($q$select 1 from public.search_knowledge((select v from ctx where k='A'), '"; drop table tasks; --', 5)$q$) = 0, 'hostile query text is just text');

-- tenant isolation of search
select t.ok(t.cnt($q$select 1 from public.search_knowledge((select v from ctx where k='B'), 'refund', 5)$q$) = 0, 'org A member cannot search org B by passing its id');
select t.as_user('bbbbbbbb-3000-0000-0000-000000000002');
select t.ok(t.cnt($q$select 1 from public.search_knowledge((select v from ctx where k='A'), 'refund', 5)$q$) = 0, 'org B member cannot search org A');
select t.ok(t.cnt($q$select 1 from public.search_knowledge((select v from ctx where k='B'), 'refund', 5)$q$) = 1, 'org B sees only its own entry');
select t.ok(t.cnt('select 1 from public.document_chunks') = 0, 'org B cannot read org A chunks');
set local role anon;
select t.throws($q$select * from public.search_knowledge('00000000-0000-0000-0000-000000000000', 'x', 5)$q$, 'anon cannot search', '42501');

-- chunks: server-written only
select t.as_user('aaaaaaaa-3000-0000-0000-000000000001');
select t.throws($q$insert into public.document_chunks (org_id, document_id, chunk_index, content) select v, 'dddddddd-0000-4000-8000-000000000001', 9, 'forged' from ctx where k='A'$q$, 'clients cannot write chunks (no forged search content)', '42501');
select t.throws($q$update public.document_chunks set content='x'$q$, 'clients cannot edit chunks', '42501');
select t.throws($q$update public.documents set summary='forged summary'$q$, 'clients cannot forge document summaries', '42501');
select t.throws($q$update public.documents set status='ready'$q$, 'clients cannot flip processing status', '42501');
select t.ok((select count(*) from public.document_chunks) = 1, 'owner reads chunks of own org');

-- KB writes: admins only
select t.as_user('cccccccc-3000-0000-0000-000000000003');
select t.throws($q$insert into public.knowledge_base_sources (org_id, kind, title) select v, 'faq', 'x' from ctx where k='A'$q$, 'member cannot add knowledge', '42501');

-- storage: uploader may delete own file; others cannot
select t.as_user('aaaaaaaa-3000-0000-0000-000000000001');
insert into storage.objects (bucket_id, name) select 'documents', v::text || '/dddddddd/agreement.docx' from ctx where k='A';
select t.as_user('cccccccc-3000-0000-0000-000000000003');
select t.ok((select count(*) from storage.objects) = 1, 'member sees org files');
delete from storage.objects;
select t.ok((select count(*) from storage.objects) = 1, 'plain member cannot delete someone else''s file');
select t.as_user('aaaaaaaa-3000-0000-0000-000000000001');
delete from storage.objects;
select t.ok((select count(*) from storage.objects) = 0, 'owner/admin can delete files');
rollback;
