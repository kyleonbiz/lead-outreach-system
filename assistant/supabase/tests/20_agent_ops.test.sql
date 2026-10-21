\o /dev/null
begin;
create schema if not exists t;  -- helper functions are recreated here so this file is standalone
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
  ('aaaaaaaa-1000-0000-0000-000000000001', 'a@a.test'), ('bbbbbbbb-1000-0000-0000-000000000002', 'b@b.test');
create temp table ctx(k text primary key, v uuid);
grant all on ctx to authenticated, service_role;
select t.as_user('aaaaaaaa-1000-0000-0000-000000000001');
insert into ctx select 'A', public.create_organization('Org A');
select t.as_user('bbbbbbbb-1000-0000-0000-000000000002');
insert into ctx select 'B', public.create_organization('Org B');
select t.as_user('bbbbbbbb-1000-0000-0000-000000000002');
insert into public.tasks (org_id, title) select v, 'B secret task' from ctx where k = 'B';
reset role;

-- user JWT (RLS applies)
select t.as_user('aaaaaaaa-1000-0000-0000-000000000001');
create temp table made(id uuid);
grant all on made to authenticated, service_role;
insert into made select ((public.agent_task_op((select v from ctx where k='A'), 'assistant', 'create', null,
  '{"title":"Assistant made this","priority":"high","due_at":"2026-10-22T14:00:00Z","recurrence":"weekly"}'))->>'id')::uuid;
select t.ok(t.cnt($q$select 1 from public.tasks where title='Assistant made this' and created_via='assistant' and priority='high'$q$) = 1,
  'agent_task_op create sets created_via and fields');
select t.ok(t.cnt($q$select 1 from public.task_history h join public.tasks k on k.id=h.task_id
  where k.title='Assistant made this' and h.event='created' and h.actor_type='assistant'$q$) = 1,
  'history attributes the change to the assistant');
select t.ok((public.agent_task_op((select v from ctx where k='A'), 'assistant', 'update', (select id from made), '{"description":"d","category":null}'))->>'description' = 'd',
  'update changes only supplied keys');
select t.ok((select priority from public.tasks where id=(select id from made)) = 'high', 'unsupplied fields are untouched');

-- cross-tenant: org A user cannot create in or touch org B, even naming org B explicitly
select t.throws($q$select public.agent_task_op((select v from ctx where k='B'), 'assistant', 'create', null, '{"title":"x"}')$q$,
  'user JWT cannot create a task in another org (RLS)', '42501');
select t.ok(public.agent_task_op((select v from ctx where k='B'), 'assistant', 'delete', (select id from public.tasks limit 1), '{}')::text = 'false',
  'delete in a foreign org affects nothing');
select t.throws($q$select public.agent_task_op((select v from ctx where k='A'), 'root', 'create', null, '{"title":"x"}')$q$,
  'invalid actor rejected', '22023');
select t.throws($q$select public.agent_task_op((select v from ctx where k='A'), 'assistant', 'drop', null, '{}')$q$,
  'unknown op rejected', '22023');

-- complete (+ recurrence)
select t.ok((public.agent_task_op((select v from ctx where k='A'), 'assistant', 'complete', (select id from made), '{}'))->>'completed' = 'true',
  'complete via agent op');
select t.ok(t.cnt($q$select 1 from public.tasks where title='Assistant made this' and status='todo'$q$) = 1, 'recurring: next occurrence created');
reset role;

-- service role (RLS bypassed) is still confined by p_org
select t.as_service();
select t.ok((public.agent_task_op((select v from ctx where k='A'), 'workflow', 'update',
  (select id from public.tasks where title='B secret task'), '{"title":"hijacked"}')) is null,
  'service role cannot update another org task through the op (org scoping)');
select t.ok((select title from public.tasks where org_id=(select v from ctx where k='B')) = 'B secret task', 'foreign task untouched');
select t.ok((public.agent_task_op((select v from ctx where k='A'), 'workflow', 'create', null, '{"title":"wf task"}'))->>'title' = 'wf task', 'service role create');
select t.ok(t.cnt($q$select 1 from public.task_history h join public.tasks k on k.id=h.task_id where k.title='wf task' and h.actor_type='workflow'$q$) = 1,
  'workflow actor attributed');
reset role;

-- anon has no access
set local role anon;
select t.throws($q$select public.agent_task_op('00000000-0000-0000-0000-000000000000', 'assistant', 'create', null, '{}')$q$, 'anon cannot call agent_task_op', '42501');
reset role;
rollback;
