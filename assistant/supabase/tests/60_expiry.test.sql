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
create or replace function t.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', true); execute 'reset role'; execute 'set local role service_role'; end $$;

insert into auth.users (id, email) values ('aaaaaaaa-5000-0000-0000-000000000001', 'a@a.test');
create temp table ctx(k text primary key, v uuid);
grant all on ctx to authenticated, service_role;
select t.as_user('aaaaaaaa-5000-0000-0000-000000000001');
insert into ctx select 'A', public.create_organization('Org A');
select t.as_service();
insert into public.workflows (id, org_id, name) select 'aaaa0000-0000-4000-8000-0000000000a1', v, 'WF' from ctx where k='A';
insert into public.workflow_versions (org_id, workflow_id, version, definition) select v, 'aaaa0000-0000-4000-8000-0000000000a1', 1, '{"steps":[{"id":"g","type":"approval","summary":"ok?"}]}' from ctx where k='A';
insert into public.workflow_runs (id, org_id, workflow_id, status) select 'eeeeeeee-0000-4000-8000-000000000001', v, 'aaaa0000-0000-4000-8000-0000000000a1', 'waiting_approval' from ctx where k='A';
insert into public.workflow_steps (org_id, run_id, step_key, step_type, status) select v, 'eeeeeeee-0000-4000-8000-000000000001', 'g', 'approval', 'waiting_approval' from ctx where k='A';
insert into public.approval_requests (id, org_id, workflow_run_id, workflow_step_key, action_type, summary, payload, expires_at)
  select '77777777-0000-4000-8000-000000000001', v, 'eeeeeeee-0000-4000-8000-000000000001', 'g', 'workflow.gate', 'ok?', '{}', now() - interval '1 hour' from ctx where k='A';
insert into public.approval_requests (id, org_id, action_type, summary, payload, expires_at)
  select '77777777-0000-4000-8000-000000000002', v, 'tasks.delete', 'old chat request', '{}', now() - interval '1 day' from ctx where k='A';
insert into public.approval_requests (id, org_id, action_type, summary, payload)
  select '77777777-0000-4000-8000-000000000003', v, 'tasks.delete', 'still valid', '{}' from ctx where k='A';

select t.ok(public.expire_approvals() = 2, 'only overdue pending approvals are expired');
select t.ok((select status from public.approval_requests where id='77777777-0000-4000-8000-000000000003') = 'pending', 'valid approvals are untouched');
select t.ok((select status from public.approval_requests where id='77777777-0000-4000-8000-000000000001') = 'expired', 'the approval is marked expired');
select t.ok((select status from public.workflow_steps where run_id='eeeeeeee-0000-4000-8000-000000000001') = 'failed', 'the workflow step waiting on it fails');
select t.ok((select error from public.workflow_steps where run_id='eeeeeeee-0000-4000-8000-000000000001') like '%expired%', 'with an explanatory error');
select t.ok((select status from public.workflow_runs where id='eeeeeeee-0000-4000-8000-000000000001') = 'queued', 'and the run is re-queued so it can finish or fail');
select t.ok(public.expire_approvals() = 0, 'expiry is idempotent');

select t.as_user('aaaaaaaa-5000-0000-0000-000000000001');
select t.throws('select public.expire_approvals()', 'clients cannot run expiry', '42501');
rollback;
