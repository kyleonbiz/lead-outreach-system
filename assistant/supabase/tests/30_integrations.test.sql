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
create or replace function t.affected(sql text) returns bigint language plpgsql as $$
declare n bigint; begin execute sql; get diagnostics n = row_count; return n; end $$;
create or replace function t.cnt(sql text) returns bigint language plpgsql as $$
declare n bigint; begin execute 'select count(*) from (' || sql || ') q' into n; return n; end $$;
create or replace function t.as_user(uid uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', uid::text, true); execute 'reset role'; execute 'set local role authenticated'; end $$;
create or replace function t.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', true); execute 'reset role'; execute 'set local role service_role'; end $$;

insert into auth.users (id, email) values
  ('aaaaaaaa-2000-0000-0000-000000000001', 'a@a.test'), ('bbbbbbbb-2000-0000-0000-000000000002', 'b@b.test'),
  ('cccccccc-2000-0000-0000-000000000003', 'c@a.test');
create temp table ctx(k text primary key, v uuid);
grant all on ctx to authenticated, service_role;
select t.as_user('aaaaaaaa-2000-0000-0000-000000000001');
insert into ctx select 'A', public.create_organization('Org A');
insert into public.organization_members (org_id, user_id, role) select v, 'cccccccc-2000-0000-0000-000000000003', 'member' from ctx where k='A';
select t.as_user('bbbbbbbb-2000-0000-0000-000000000002');
insert into ctx select 'B', public.create_organization('Org B');
select t.as_service();
insert into public.connected_integrations (id, org_id, provider, external_account) select '99999999-9999-4999-8999-999999999999', v, 'google_gmail', 'a@acme.com' from ctx where k='A';
insert into public.integration_credentials (integration_id, org_id, encrypted_payload) select '99999999-9999-4999-8999-999999999999', v, 'v1.x.y' from ctx where k='A';

-- credential isolation, from every client role
select t.as_user('aaaaaaaa-2000-0000-0000-000000000001');
select t.throws('select encrypted_payload from public.integration_credentials', 'owner cannot read OAuth ciphertext', '42501');
select t.throws($q$select count(*) from public.integration_credentials$q$, 'owner cannot even count credentials', '42501');
select t.throws($q$delete from public.integration_credentials$q$, 'owner cannot delete credentials directly (disconnect goes through the server)', '42501');
select t.throws($q$update public.connected_integrations set status='connected'$q$, 'owner cannot edit integration state', '42501');
select t.ok(t.cnt('select 1 from public.connected_integrations') = 1, 'owner can see integration status');
select t.as_user('bbbbbbbb-2000-0000-0000-000000000002');
select t.ok(t.cnt('select 1 from public.connected_integrations') = 0, 'other org cannot see the integration');
select t.as_user('cccccccc-2000-0000-0000-000000000003');
select t.ok(t.cnt('select 1 from public.connected_integrations') = 1, 'plain member can see connection status (no secrets)');
set local role anon;
select t.throws('select * from public.connected_integrations', 'anon cannot see integrations', '42501');

-- email rules: only admins may change them
select t.as_user('cccccccc-2000-0000-0000-000000000003');
select t.ok(t.affected($q$update public.organization_settings set email_rules='{"vip_senders":["x@y.com"]}'$q$) = 0, 'member cannot change email rules');
select t.as_user('aaaaaaaa-2000-0000-0000-000000000001');
select t.ok(t.affected($q$update public.organization_settings set email_rules='{"vip_senders":["x@y.com"]}'$q$) = 1, 'admin can change email rules');
select t.throws($q$update public.organization_settings set email_rules='[1]'$q$, 'email rules must be a JSON object', '23514');
select t.as_user('bbbbbbbb-2000-0000-0000-000000000002');
select t.ok((select email_rules from public.organization_settings) = '{}'::jsonb, 'other org rules untouched');
rollback;
