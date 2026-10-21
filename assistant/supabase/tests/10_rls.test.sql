-- Row Level Security / tenancy tests. Runs inside one transaction and rolls back.
-- Any failed assertion raises and aborts the run (psql ON_ERROR_STOP).
\o /dev/null
begin;

create schema t;
grant usage on schema t to authenticated, anon, service_role;

create function t.ok(cond boolean, name text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', name; end if;
  raise notice 'ok - %', name;
end $$;

-- Expect `sql` to fail. Optionally require a SQLSTATE (42501 = permission denied / RLS violation).
create function t.throws(sql text, name text, expected_state text default null) returns void language plpgsql as $$
declare st text;
begin
  begin
    execute sql;
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    if expected_state is not null and st <> expected_state then
      raise exception 'FAIL: % (expected %, got % : %)', name, expected_state, st, sqlerrm;
    end if;
    raise notice 'ok - % [%]', name, st;
    return;
  end;
  raise exception 'FAIL: % (statement succeeded but must be rejected)', name;
end $$;

-- Rows affected by a DML statement under the current role
create function t.affected(sql text) returns bigint language plpgsql as $$
declare n bigint;
begin execute sql; get diagnostics n = row_count; return n; end $$;

-- Row count visible to the current role for a query
create function t.cnt(sql text) returns bigint language plpgsql as $$
declare n bigint;
begin execute 'select count(*) from (' || sql || ') q' into n; return n; end $$;

create function t.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  execute 'set local role authenticated';
end $$;
create function t.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
end $$;
create function t.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'reset role';
  execute 'set local role service_role';
end $$;

-- ===== fixtures ============================================================
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'alice@a.test', '{"full_name":"Alice"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bob@b.test',   '{"full_name":"Bob"}'),
  ('cccccccc-0000-0000-0000-000000000003', 'carol@a.test', '{"full_name":"Carol"}'),
  ('dddddddd-0000-0000-0000-000000000004', 'dave@none.test', '{}');

select t.ok((select count(*) from public.profiles) = 4, 'profile auto-created per auth user');

select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
create temp table ctx(k text primary key, v uuid);
grant all on ctx to authenticated, service_role;
insert into ctx select 'orgA', public.create_organization('Org A', 'America/New_York');
select t.as_user('bbbbbbbb-0000-0000-0000-000000000002');
insert into ctx select 'orgB', public.create_organization('Org B');

-- alice (owner) adds carol as a plain member of Org A
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
insert into public.organization_members (org_id, user_id, role)
  select v, 'cccccccc-0000-0000-0000-000000000003', 'member' from ctx where k = 'orgA';

-- seed one task per org
insert into public.tasks (org_id, title) select v, 'A task' from ctx where k = 'orgA';
select t.as_user('bbbbbbbb-0000-0000-0000-000000000002');
insert into public.tasks (org_id, title) select v, 'B task' from ctx where k = 'orgB';
reset role;

-- ===== tenant isolation ====================================================
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select t.ok(t.cnt('select 1 from public.organizations') = 1, 'alice sees only her organization');
select t.ok(t.cnt('select 1 from public.tasks') = 1 and
            (select title from public.tasks) = 'A task', 'alice sees only org A tasks');
select t.ok(t.cnt('select 1 from public.organization_settings') = 1, 'alice sees only own settings');
select t.ok(t.cnt('select 1 from public.profiles') = 2, 'alice sees profiles of co-members only (self + carol)');

select t.throws($$insert into public.tasks (org_id, title) select v, 'evil' from ctx where k = 'orgB'$$,
  'alice cannot insert a task into org B', '42501');
select t.ok(
  t.affected($q$update public.tasks set title = 'pwned' where title = 'B task'$q$) = 0,
  'alice cannot update org B tasks (0 rows)');
select t.ok(
  t.affected($q$delete from public.tasks where title = 'B task'$q$) = 0,
  'alice cannot delete org B tasks (0 rows)');
select t.throws($$update public.tasks set org_id = (select v from ctx where k='orgB')$$,
  'org_id cannot be changed on a task (column privilege)', '42501');
select t.throws($$insert into public.assistant_conversations (org_id, title) select v, 'x' from ctx where k = 'orgB'$$,
  'alice cannot open a conversation in org B', '42501');

-- composite FK: a task cannot be assigned to someone outside its organization
select t.throws($$update public.tasks set assignee_id = 'bbbbbbbb-0000-0000-0000-000000000002'$$,
  'cannot assign a task to a user outside the org', '23503');

reset role;
select t.as_user('bbbbbbbb-0000-0000-0000-000000000002');
select t.ok(t.cnt('select 1 from public.tasks') = 1 and (select title from public.tasks) = 'B task',
  'bob sees only org B tasks');
select t.ok(
  (select public.complete_task((select id from public.tasks))) is null, 'bob completes own non-recurring task -> no next');
reset role;

select t.as_user('dddddddd-0000-0000-0000-000000000004');
select t.ok(t.cnt('select 1 from public.organizations') = 0 and t.cnt('select 1 from public.tasks') = 0,
  'user with no org sees nothing');
reset role;

select t.as_anon();
select t.throws('select * from public.tasks', 'anon cannot read tasks', '42501');
select t.throws('select * from public.organizations', 'anon cannot read organizations', '42501');
select t.throws($$select public.create_organization('x')$$, 'anon cannot call create_organization', '42501');
reset role;

-- ===== role-based limits within an org ====================================
select t.as_user('cccccccc-0000-0000-0000-000000000003');   -- carol: plain member of A
select t.ok(t.cnt('select 1 from public.tasks') = 1, 'member can read org tasks');
insert into public.tasks (org_id, title, priority) select v, 'Carol task', 'high' from ctx where k = 'orgA';
select t.ok(
  t.affected($q$update public.organizations set name = 'Hijack'$q$) = 0,
  'member cannot rename the organization');
select t.ok(
  t.affected($q$update public.organization_settings set timezone = 'UTC'$q$) = 0,
  'member cannot change org settings');
select t.throws($$insert into public.workflows (org_id, name) select v, 'wf' from ctx where k='orgA'$$,
  'member cannot create workflows', '42501');
select t.throws($$insert into public.organization_members (org_id, user_id, role)
   select v, 'dddddddd-0000-0000-0000-000000000004', 'owner' from ctx where k='orgA'$$,
  'member cannot add members / escalate', '42501');
select t.ok(t.affected($q$update public.organization_members set role = 'owner' where user_id = 'cccccccc-0000-0000-0000-000000000003'$q$) = 0,
  'member cannot promote self');
select t.ok(t.cnt('select 1 from public.usage_records') = 0, 'member cannot read usage records');
reset role;

-- ===== secrets & append-only logs =========================================
select t.as_service();
insert into public.connected_integrations (org_id, provider, external_account)
  select v, 'google_gmail', 'a@a.test' from ctx where k = 'orgA';
insert into public.integration_credentials (integration_id, org_id, encrypted_payload)
  select i.id, i.org_id, 'ciphertext' from public.connected_integrations i;
insert into public.action_logs (org_id, actor_type, action, status, idempotency_key)
  select v, 'assistant', 'email.draft', 'success', 'key-1' from ctx where k = 'orgA';
reset role;

select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select t.ok(t.cnt('select 1 from public.connected_integrations') = 1, 'owner sees integration status');
select t.throws('select * from public.integration_credentials', 'authenticated cannot read credentials', '42501');
select t.throws($$insert into public.integration_credentials (integration_id, org_id, encrypted_payload)
   select id, org_id, 'x' from public.connected_integrations$$, 'authenticated cannot write credentials', '42501');
select t.throws($$insert into public.connected_integrations (org_id, provider, external_account)
   select v, 'google_calendar', 'x' from ctx where k='orgA'$$, 'clients cannot fabricate a connected integration', '42501');
select t.throws($$insert into public.action_logs (org_id, actor_type, action, status)
   select v, 'user', 'fake', 'success' from ctx where k='orgA'$$, 'clients cannot write activity logs', '42501');
select t.throws($$update public.action_logs set status = 'failure'$$, 'activity log is immutable to clients', '42501');
select t.throws($$delete from public.action_logs$$, 'activity log cannot be deleted by clients', '42501');
select t.ok(t.cnt('select 1 from public.action_logs') >= 1, 'members can read the activity log');
reset role;

select t.as_service();
select t.throws($$insert into public.action_logs (org_id, actor_type, action, status, idempotency_key)
   select v, 'assistant', 'email.draft', 'success', 'key-1' from ctx where k = 'orgA'$$,
  'duplicate idempotency key rejected (duplicate-action protection)', '23505');
reset role;

-- ===== conversations & messages ===========================================
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
insert into public.assistant_conversations (org_id, title) select v, 'Alice chat' from ctx where k='orgA';
insert into public.assistant_messages (org_id, conversation_id, role, content)
  select org_id, id, 'user', 'hello' from public.assistant_conversations;
select t.throws($$insert into public.assistant_messages (org_id, conversation_id, role, content)
   select org_id, id, 'assistant', 'I did the thing' from public.assistant_conversations$$,
  'clients cannot forge assistant messages', '42501');
select t.throws($$insert into public.assistant_messages (org_id, conversation_id, role, content)
   select (select v from ctx where k='orgB'), id, 'user', 'x' from public.assistant_conversations$$,
  'message cannot point at another org (composite FK / RLS)', null);
reset role;

select t.as_user('cccccccc-0000-0000-0000-000000000003');
select t.ok(t.cnt('select 1 from public.assistant_conversations') = 0,
  'conversations are private even within the same org');
select t.ok(t.cnt('select 1 from public.assistant_messages') = 0, 'messages are private even within the same org');
reset role;

-- ===== tasks: completion history & recurrence =============================
select t.as_user('cccccccc-0000-0000-0000-000000000003');
insert into public.tasks (org_id, title, due_at, recurrence)
  select v, 'Weekly report', now() + interval '1 day', 'weekly' from ctx where k='orgA';
select t.ok(public.complete_task((select id from public.tasks where title='Weekly report' and status='todo')) is not null,
  'completing a recurring task creates the next occurrence');
select t.ok(t.cnt($$select 1 from public.tasks where title='Weekly report' and status='done' and completed_at is not null$$) = 1,
  'completed task has completed_at');
select t.ok(t.cnt($$select 1 from public.tasks where title='Weekly report' and status='todo' and due_at > now() + interval '6 days'$$) = 1,
  'next occurrence is due a week later');
select t.ok(t.cnt($$select 1 from public.task_history h join public.tasks k on k.id=h.task_id
                    where k.title='Weekly report' and h.event='completed'$$) = 1, 'completion recorded in task history');
select t.ok(t.cnt($$select 1 from public.task_history h join public.tasks k on k.id=h.task_id
                    where k.title='Weekly report' and h.event='created' and h.actor_type='user'$$) = 2,
  'creation recorded with actor type');
-- assistant actions are attributed via the per-transaction setting
select set_config('app.actor_type', 'assistant', true);
insert into public.tasks (org_id, title, created_via) select v, 'Assistant task', 'assistant' from ctx where k='orgA';
select t.ok(t.cnt($$select 1 from public.task_history h join public.tasks k on k.id=h.task_id
                    where k.title='Assistant task' and h.actor_type='assistant'$$) = 1,
  'assistant-originated change is attributed to assistant');
select set_config('app.actor_type', '', true);
reset role;

-- ===== approvals ==========================================================
select t.as_service();
insert into public.approval_requests (org_id, requested_by, action_type, summary, payload)
  select v, 'cccccccc-0000-0000-0000-000000000003', 'email.send', 'Send reply to x@y.test', '{"to":"x@y.test"}'
  from ctx where k='orgA';
insert into public.approval_requests (org_id, requested_by, action_type, summary, payload)
  select v, 'cccccccc-0000-0000-0000-000000000003', 'email.send', 'Second', '{"to":"z@y.test"}'
  from ctx where k='orgA';
reset role;

select t.as_user('bbbbbbbb-0000-0000-0000-000000000002');
select t.ok(t.cnt('select 1 from public.approval_requests') = 0, 'other orgs cannot see approvals');
select t.ok(t.affected($q$update public.approval_requests set status='approved'$q$) = 0,
  'other orgs cannot approve');
reset role;

select t.as_user('cccccccc-0000-0000-0000-000000000003');   -- the requester
select t.throws($$update public.approval_requests set payload = '{"to":"attacker@evil.test"}'$$,
  'approval payload cannot be altered by users', '42501');
select t.throws($$update public.approval_requests set status='executed'$$,
  'users cannot mark an approval executed', '23514');
update public.approval_requests set status='approved', decision_note='ok' where summary='Send reply to x@y.test';
select t.ok(t.cnt($$select 1 from public.approval_requests where status='approved' and decided_by='cccccccc-0000-0000-0000-000000000003' and decided_at is not null$$) = 1,
  'decision is stamped with the decider');
select t.ok(t.affected($q$update public.approval_requests set status='rejected' where summary='Send reply to x@y.test'$q$) = 0
            and t.cnt($q$select 1 from public.approval_requests where summary='Send reply to x@y.test' and status='approved'$q$) = 1,
  'a decided approval cannot be flipped');
reset role;

-- ===== org membership safety ==============================================
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select t.throws($$delete from public.organization_members where user_id='aaaaaaaa-0000-0000-0000-000000000001'$$,
  'last owner cannot leave the organization', '23514');
select t.throws($$update public.organization_members set role='member' where user_id='aaaaaaaa-0000-0000-0000-000000000001'$$,
  'last owner cannot be demoted', '23514');
reset role;

-- ===== storage ============================================================
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
insert into storage.objects (bucket_id, name) select 'documents', v::text || '/contract.pdf' from ctx where k='orgA';
select t.throws($$insert into storage.objects (bucket_id, name) select 'documents', v::text || '/steal.pdf' from ctx where k='orgB'$$,
  'cannot upload into another org''s folder', '42501');
select t.throws($$insert into storage.objects (bucket_id, name) values ('documents', 'not-a-uuid/x.pdf')$$,
  'objects outside an org folder are rejected', '42501');
reset role;
select t.as_user('bbbbbbbb-0000-0000-0000-000000000002');
select t.ok(t.cnt('select 1 from storage.objects') = 0, 'org B cannot list org A files');
reset role;

-- documents.storage_path must be namespaced under the owning org
select t.as_user('aaaaaaaa-0000-0000-0000-000000000001');
select t.throws($$insert into public.documents (org_id, name, storage_path, uploaded_by)
   select v, 'sneaky', (select v::text from ctx where k='orgB') || '/x.pdf', auth.uid() from ctx where k='orgA'$$,
  'document path must be inside its own org folder', '23514');
reset role;

-- ===== org deletion cascades cleanly (service role) ========================
select t.as_service();
delete from public.organizations where id = (select v from ctx where k='orgB');
select t.ok(t.cnt('select 1 from public.tasks where title = ''B task''') = 0, 'deleting an org cascades its data');
reset role;

rollback;
