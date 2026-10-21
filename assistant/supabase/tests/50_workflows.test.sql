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
  ('aaaaaaaa-4000-0000-0000-000000000001', 'a@a.test'), ('bbbbbbbb-4000-0000-0000-000000000002', 'b@b.test'),
  ('cccccccc-4000-0000-0000-000000000003', 'c@a.test');
create temp table ctx(k text primary key, v uuid);
grant all on ctx to authenticated, service_role;
select t.as_user('aaaaaaaa-4000-0000-0000-000000000001');
insert into ctx select 'A', public.create_organization('Org A');
insert into public.organization_members (org_id, user_id, role) select v, 'cccccccc-4000-0000-0000-000000000003', 'member' from ctx where k='A';
select t.as_user('bbbbbbbb-4000-0000-0000-000000000002');
insert into ctx select 'B', public.create_organization('Org B');

-- the validating server function creates workflows (service role); emulate it
select t.as_service();
insert into public.workflows (id, org_id, name, trigger_type, trigger_config, enabled) select 'aaaa0000-0000-4000-8000-000000000001', v, 'A sched', 'schedule', '{"cron":"0 8 * * 1-5"}', true from ctx where k='A';
insert into public.workflows (id, org_id, name, trigger_type, trigger_config, enabled) select 'aaaa0000-0000-4000-8000-000000000002', v, 'A on overdue', 'event', '{"event":"task.overdue"}', true from ctx where k='A';
insert into public.workflows (id, org_id, name, trigger_type, trigger_config, enabled) select 'aaaa0000-0000-4000-8000-000000000003', v, 'A disabled listener', 'event', '{"event":"task.overdue"}', false from ctx where k='A';
insert into public.workflows (id, org_id, name) select 'bbbb0000-0000-4000-8000-000000000001', v, 'B wf' from ctx where k='B';
insert into public.workflow_versions (org_id, workflow_id, version, definition)
  select w.org_id, w.id, 1, '{"steps":[{"id":"a","type":"notify","title":"hi"}]}' from public.workflows w;

-- ===== idempotent enqueue (duplicate-run protection)
select t.ok(public.enqueue_workflow_run('aaaa0000-0000-4000-8000-000000000001', 'schedule', 'sched:1:202610210800') is not null, 'first enqueue creates a run');
select t.ok(public.enqueue_workflow_run('aaaa0000-0000-4000-8000-000000000001', 'schedule', 'sched:1:202610210800') is null, 'same trigger key enqueues nothing (no duplicate run)');
select t.ok(t.cnt($q$select 1 from public.workflow_runs where workflow_id='aaaa0000-0000-4000-8000-000000000001'$q$) = 1, 'exactly one run exists');
select t.ok(public.enqueue_workflow_run('aaaa0000-0000-4000-8000-000000000001', 'schedule', 'sched:1:202610210801') is not null, 'a different minute enqueues again');
select t.ok(public.enqueue_workflow_run('00000000-0000-4000-8000-000000000000', 'manual', 'm1') is null, 'unknown workflow enqueues nothing');

-- ===== claiming: skip-locked + lease
create temp table claimed(id uuid, attempt int);
grant all on claimed to service_role;
insert into claimed select id, attempt from public.claim_workflow_runs(1, 300);
select t.ok((select count(*) from claimed) = 1, 'claim returns one run (limit 1)');
select t.ok(t.cnt($q$select 1 from public.workflow_runs where status='running' and locked_until > now()$q$) = 1, 'claimed run is running with a lease');
select t.ok((select count(*) from public.claim_workflow_runs(5, 300)) = 1, 'the second claim gets only the remaining queued run');
select t.ok((select count(*) from public.claim_workflow_runs(5, 300)) = 0, 'leased runs are not claimed twice');
update public.workflow_runs set locked_until = now() - interval '1 minute' where id = (select id from claimed);
select t.ok((select attempt from public.claim_workflow_runs(5, 300)) = 2, 'expired lease: run is reclaimed and counted as another attempt');
update public.workflow_runs set status='queued', locked_until=null, next_attempt_at = now() + interval '1 hour';
select t.ok((select count(*) from public.claim_workflow_runs(5, 300)) = 0, 'a run waiting for its retry time is not claimed early');
update public.workflow_runs set next_attempt_at = now() - interval '1 second';
select t.ok((select count(*) from public.claim_workflow_runs(5, 300)) = 2, 'claimed once the retry time passes');

-- ===== approvals resume
update public.workflow_runs set status='waiting_approval', locked_until=null where id = (select id from claimed);
select t.ok((select count(*) from public.claim_workflow_runs(5, 300)) = 0, 'runs waiting for approval are never claimed');
insert into public.workflow_steps (org_id, run_id, step_key, step_type, status)
  select org_id, id, 'gate', 'approval', 'waiting_approval' from public.workflow_runs where id = (select id from claimed);
select t.ok(public.resume_workflow_step((select id from claimed), 'gate', 'succeeded', null, null) is true, 'resume completes the waiting step');
select t.ok((select status from public.workflow_runs where id = (select id from claimed)) = 'queued', 'and re-queues the run');
select t.ok(public.resume_workflow_step((select id from claimed), 'gate', 'succeeded', null, null) is false, 'resume is a no-op the second time');
select t.throws($q$select public.resume_workflow_step((select id from claimed), 'gate', 'executed', null, null)$q$, 'resume only accepts succeeded/failed', '22023');

-- ===== events
insert into public.tasks (org_id, title, due_at, status) select v, 'Overdue invoice', now() - interval '2 days', 'todo' from ctx where k='A';
insert into public.tasks (org_id, title, due_at, status) select v, 'B overdue', now() - interval '2 days', 'todo' from ctx where k='B';
select t.ok(public.dispatch_workflow_events(50) = 1, 'overdue task fans out to the ONE enabled listener (not the disabled one, not org B)');
select t.ok(t.cnt($q$select 1 from public.workflow_events where type='task.overdue'$q$) = 1, 'no events are created for orgs with no listener');
select t.ok(public.dispatch_workflow_events(50) = 0, 'events are dispatched once');
select t.ok(t.cnt($q$select 1 from public.workflow_runs where trigger_source='event' and event->>'title'='Overdue invoice'$q$) = 1, 'the run carries the event payload');
update public.workflow_events set processed_at = null;
select t.ok(public.dispatch_workflow_events(50) = 1 and (select count(*) from public.workflow_runs where trigger_source='event') = 1, 're-dispatching the same event cannot create a duplicate run');
-- document.ready
insert into public.workflows (id, org_id, name, trigger_type, trigger_config, enabled) select 'aaaa0000-0000-4000-8000-000000000009', v, 'On doc', 'event', '{"event":"document.ready"}', true from ctx where k='A';
insert into public.documents (id, org_id, name, storage_path, status) select 'dddddddd-1111-4000-8000-000000000001', v, 'x.txt', v::text || '/x/x.txt', 'processing' from ctx where k='A';
update public.documents set status = 'ready' where id = 'dddddddd-1111-4000-8000-000000000001';
select t.ok(t.cnt($q$select 1 from public.workflow_events where type='document.ready'$q$) = 1, 'document ready emits an event for a listening org');

-- ===== client privileges & tenant isolation
select t.as_user('aaaaaaaa-4000-0000-0000-000000000001');
select t.throws($q$insert into public.workflows (org_id, name) select v, 'sneaky' from ctx where k='A'$q$, 'clients cannot create workflows directly (validation happens in workflow-save)', '42501');
select t.throws($q$insert into public.workflow_versions (org_id, workflow_id, version, definition) values ((select v from ctx where k='A'), 'aaaa0000-0000-4000-8000-000000000001', 9, '{"steps":[{"id":"x","type":"script"}]}')$q$, 'clients cannot write unvalidated definitions', '42501');
select t.throws($q$update public.workflows set trigger_config='{"cron":"* * * * *"}'$q$, 'clients cannot change triggers directly', '42501');
select t.throws($q$update public.workflows set current_version = 9$q$, 'clients cannot switch versions directly', '42501');
select t.ok(t.affected($q$update public.workflows set enabled = false where id='aaaa0000-0000-4000-8000-000000000001'$q$) = 1, 'admins can enable/disable');
select t.throws($q$select public.enqueue_workflow_run('aaaa0000-0000-4000-8000-000000000001', 'manual', 'x')$q$, 'clients cannot enqueue runs directly', '42501');
select t.throws($q$select * from public.claim_workflow_runs(5, 300)$q$, 'clients cannot claim runs', '42501');
select t.throws($q$select public.dispatch_workflow_events(5)$q$, 'clients cannot dispatch events', '42501');
select t.throws($q$update public.workflow_runs set status='succeeded'$q$, 'clients cannot alter run state', '42501');
select t.ok(t.cnt('select 1 from public.workflows') = 4 and t.cnt('select 1 from public.workflow_runs') >= 1, 'org A sees its workflows and runs');
select t.as_user('cccccccc-4000-0000-0000-000000000003');
select t.ok(t.affected($q$update public.workflows set enabled = true$q$) = 0, 'plain members cannot toggle workflows');
select t.ok(t.cnt('select 1 from public.workflow_events') >= 1, 'members can see events of their org');
select t.as_user('bbbbbbbb-4000-0000-0000-000000000002');
select t.ok(t.cnt('select 1 from public.workflows') = 1, 'org B sees only its own workflow');
select t.ok(t.cnt('select 1 from public.workflow_runs') = 0 and t.cnt('select 1 from public.workflow_events') = 0 and t.cnt('select 1 from public.workflow_steps') = 0, 'org B sees none of org A runs, events or steps');
select t.ok(t.cnt('select 1 from public.workflow_versions') = 1, 'org B sees only its own versions');
rollback;
