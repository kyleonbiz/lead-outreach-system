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
create or replace function t.as_user(uid uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', uid::text, true); execute 'reset role'; execute 'set local role authenticated'; end $$;
create or replace function t.as_anon() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', true); execute 'reset role'; execute 'set local role anon'; end $$;
create or replace function t.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', true); execute 'reset role'; execute 'set local role service_role'; end $$;
create or replace function t.cnt(sql text) returns bigint language plpgsql as $$
declare n bigint; begin execute 'select count(*) from (' || sql || ') q' into n; return n; end $$;

insert into auth.users (id, email) values
  ('aaaaaaaa-8000-0000-0000-000000000001', 'owner@a.test'),
  ('aaaaaaaa-8000-0000-0000-000000000002', 'admin@a.test'),
  ('aaaaaaaa-8000-0000-0000-000000000003', 'member@a.test'),
  ('bbbbbbbb-8000-0000-0000-000000000001', 'owner@b.test');
create temp table ctx(k text primary key, v uuid);
grant all on ctx to authenticated, service_role;
select t.as_user('aaaaaaaa-8000-0000-0000-000000000001');
insert into ctx select 'A', public.create_organization('Org A');
insert into public.organization_members (org_id, user_id, role) select v, 'aaaaaaaa-8000-0000-0000-000000000002', 'admin' from ctx where k='A';
insert into public.organization_members (org_id, user_id, role) select v, 'aaaaaaaa-8000-0000-0000-000000000003', 'member' from ctx where k='A';
select t.as_user('bbbbbbbb-8000-0000-0000-000000000001');
insert into ctx select 'B', public.create_organization('Org B');

-- ===== who may change rules ================================================
select t.as_user('aaaaaaaa-8000-0000-0000-000000000002');   -- admin
select t.ok(public.set_approval_policy((select v from ctx where k='A'),
  '{"auto_approve":[{"action":"email.send","allowed_recipients":["boss@gmail.com","@acme.com"]},{"action":"calendar.create_event","internal_domains":["acme.com"]}]}') is not null,
  'an admin can set narrow rules');
select t.ok(t.cnt($$select 1 from public.organization_settings where org_id=(select v from ctx where k='A') and jsonb_array_length(approval_policy->'auto_approve') = 2$$) = 1,
  'the rules are stored');
select t.ok(t.cnt($$select 1 from public.action_logs where org_id=(select v from ctx where k='A') and action='approval_policy.updated'
  and category='audit' and user_id='aaaaaaaa-8000-0000-0000-000000000002' and output->'after'->'auto_approve' is not null and input->'before' is not null$$) = 1,
  'the change is audited with who, before and after');

select t.as_user('aaaaaaaa-8000-0000-0000-000000000003');   -- plain member
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[]}')$$, 'a plain member cannot change rules', '42501');
select t.as_user('bbbbbbbb-8000-0000-0000-000000000001');   -- owner of ANOTHER org
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[]}')$$, 'another organization''s owner cannot change rules', '42501');
select t.as_anon();
select t.throws($$select public.set_approval_policy('00000000-0000-0000-0000-000000000000', '{"auto_approve":[]}')$$, 'anonymous callers cannot call it', '42501');

-- ===== direct writes are closed =============================================
select t.as_user('aaaaaaaa-8000-0000-0000-000000000001');   -- even the owner
select t.throws($$update public.organization_settings set approval_policy = '{"auto_approve":[]}'$$, 'clients cannot bypass the RPC with a direct column update', '42501');
select t.ok(t.cnt('select 1 from public.action_logs') >= 1, 'owner can read the audit trail');
select t.ok((select timezone from public.organization_settings where org_id=(select v from ctx where k='A')) is not null, 'other settings columns remain readable');

-- ===== broad / unsafe rules are rejected by the RPC ===========================
select t.as_user('aaaaaaaa-8000-0000-0000-000000000001');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[{"action":"email.send","allowed_recipients":["@gmail.com"]}]}')$$, 'whole free-mail domain refused', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[{"action":"email.send","allowed_recipients":["@co.uk"]}]}')$$, 'public suffix refused', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[{"action":"email.send","allowed_recipients":["@com"]}]}')$$, 'bare TLD refused', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[{"action":"email.send","allowed_recipients":["*"]}]}')$$, 'wildcard refused', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[{"action":"email.send","allowed_recipients":["acme.com"]}]}')$$, 'bare domain in an email rule refused', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[{"action":"email.send","allowed_recipients":["a@acme.com,b@evil.com"]}]}')$$, 'comma-joined recipients refused', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[{"action":"email.send","allowed_recipients":["Boss <boss@acme.com>"]}]}')$$, 'display-name trick refused', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[{"action":"email.send","allowed_recipients":[5]}]}')$$, 'non-text entry refused', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[{"action":"email.send","allowed_recipients":[]}]}')$$, 'empty list refused', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[{"action":"calendar.create_event","internal_domains":["gmail.com"]}]}')$$, 'calendar: free-mail domain refused', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[{"action":"tasks.delete"}]}')$$, 'deletes can never be pre-authorized', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[{"action":"payments.send","limit":100}]}')$$, 'payments can never be pre-authorized', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[{"action":"email.send","allowed_recipients":["a@acme.com"],"any":true}]}')$$, 'unknown rule field refused', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[],"allow_all":true}')$$, 'unknown policy field refused', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[{"action":"email.send","allowed_recipients":["a@acme.com"]},{"action":"email.send","allowed_recipients":["b@acme.com"]}]}')$$, 'two rules for one action refused', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), '"allow everything"')$$, 'non-object policy refused', '22023');
select t.throws($$select public.set_approval_policy((select v from ctx where k='A'), null)$$, 'null policy refused', '22023');
select t.ok((select jsonb_array_length(approval_policy->'auto_approve') from public.organization_settings where org_id=(select v from ctx where k='A')) = 2,
  'rejected attempts left the stored rules unchanged');

-- ===== the constraint holds even for privileged writers =======================
select t.as_service();
select t.throws($$update public.organization_settings set approval_policy = '{"auto_approve":[{"action":"email.send","allowed_recipients":["@gmail.com"]}]}'$$,
  'even the service role cannot store a broad rule', '23514');
select t.throws($$update public.organization_settings set approval_policy = '{"auto_approve":[{"action":"tasks.delete"}]}'$$,
  'even the service role cannot store a delete pre-authorization', '23514');
update public.organization_settings set approval_policy = '{"auto_approve":[]}' where org_id = (select v from ctx where k='A');
select t.ok(true, 'the service role can still store a valid (empty) policy');

-- ===== clearing rules is allowed and audited ==================================
select t.as_user('aaaaaaaa-8000-0000-0000-000000000001');
select t.ok(public.set_approval_policy((select v from ctx where k='A'), '{"auto_approve":[]}') is not null, 'rules can be cleared');
select t.ok(t.cnt($$select 1 from public.action_logs where org_id=(select v from ctx where k='A') and action='approval_policy.updated'$$) = 2, 'every successful change has an audit entry (and failures add none)');
select t.as_user('bbbbbbbb-8000-0000-0000-000000000001');
select t.ok(t.cnt($$select 1 from public.action_logs where action='approval_policy.updated'$$) = 0, 'other organizations cannot see this audit trail');
rollback;
