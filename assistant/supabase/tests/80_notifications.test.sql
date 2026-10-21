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
create or replace function t.cnt(sql text) returns bigint language plpgsql as $$
declare n bigint; begin execute 'select count(*) from (' || sql || ') q' into n; return n; end $$;
create or replace function t.affected(sql text) returns bigint language plpgsql as $$
declare n bigint; begin execute sql; get diagnostics n = row_count; return n; end $$;

insert into auth.users (id, email, email_confirmed_at) values
  ('aaaaaaaa-9000-0000-0000-000000000001', 'owner@a.test', now()),
  ('aaaaaaaa-9000-0000-0000-000000000002', 'admin@a.test', now()),
  ('aaaaaaaa-9000-0000-0000-000000000003', 'member@a.test', now()),
  ('aaaaaaaa-9000-0000-0000-000000000004', 'unverified@a.test', null),
  ('bbbbbbbb-9000-0000-0000-000000000001', 'owner@b.test', now());
create temp table ctx(k text primary key, v uuid);
grant all on ctx to authenticated, service_role;
select t.as_user('aaaaaaaa-9000-0000-0000-000000000001');
insert into ctx select 'A', public.create_organization('Org A');
insert into public.organization_members (org_id, user_id, role) select v, 'aaaaaaaa-9000-0000-0000-000000000002', 'admin' from ctx where k='A';
insert into public.organization_members (org_id, user_id, role) select v, 'aaaaaaaa-9000-0000-0000-000000000003', 'member' from ctx where k='A';
insert into public.organization_members (org_id, user_id, role) select v, 'aaaaaaaa-9000-0000-0000-000000000004', 'admin' from ctx where k='A';
select t.as_user('bbbbbbbb-9000-0000-0000-000000000001');
insert into ctx select 'B', public.create_organization('Org B');

select t.as_service();
insert into public.notification_channels (id, org_id, kind, name, url_hint, events) select 'c1c1c1c1-0000-4000-8000-000000000001', v, 'slack', 'Ops', 'hooks.slack.com/…/abcd', array['workflow_failed','task_overdue'] from ctx where k='A';
insert into public.notification_channels (id, org_id, kind, name, url_hint, events) select 'c2c2c2c2-0000-4000-8000-000000000002', v, 'teams', 'Approvals', 'x.webhook.office.com/…/zz', array['approval_needed'] from ctx where k='A';
insert into public.notification_channels (id, org_id, kind, name, url_hint, events, enabled) select 'c3c3c3c3-0000-4000-8000-000000000003', v, 'slack', 'Off', 'hooks.slack.com/…/off', array['workflow_failed'], false from ctx where k='A';
insert into public.notification_channels (id, org_id, kind, name, url_hint) select 'c4c4c4c4-0000-4000-8000-000000000004', v, 'slack', 'B hook', 'hooks.slack.com/…/bbbb' from ctx where k='B';
insert into public.notification_channel_secrets (channel_id, org_id, encrypted_url) select 'c1c1c1c1-0000-4000-8000-000000000001', v, 'v1.ciphertext' from ctx where k='A';

-- ===== schema guards ==========================================================
select t.throws($$insert into public.notification_channels (org_id, kind, name, url_hint, events) select v, 'slack', 'x', 'h', array['everything'] from ctx where k='A'$$, 'unknown event names are rejected', '23514');
select t.throws($$insert into public.notification_channels (org_id, kind, name, url_hint, events) select v, 'slack', 'x', 'h', array[]::text[] from ctx where k='A'$$, 'a channel must subscribe to something', '23514');
select t.throws($$insert into public.notification_channels (org_id, kind, name, url_hint) select v, 'discord', 'x', 'h' from ctx where k='A'$$, 'only supported channel kinds', '23514');

-- ===== fan-out ================================================================
select t.as_service();
insert into public.notifications (id, org_id, type, title, body, link) select 'f0000000-0000-4000-8000-000000000001', v, 'workflow_failed', 'Workflow "Daily" failed', 'Step 2: boom', '/workflows' from ctx where k='A';
select t.ok(t.cnt($$select 1 from public.notification_deliveries where notification_id='f0000000-0000-4000-8000-000000000001' and channel='email'$$) = 3,
  'org-wide failure e-mails owner and both admins (not the plain member)');
select t.ok(t.cnt($$select 1 from public.notification_deliveries where notification_id='f0000000-0000-4000-8000-000000000001' and channel='email' and user_id='aaaaaaaa-9000-0000-0000-000000000003'$$) = 0,
  'plain members are not e-mailed organization-wide alerts');
select t.ok(t.cnt($$select 1 from public.notification_deliveries where notification_id='f0000000-0000-4000-8000-000000000001' and channel_id='c1c1c1c1-0000-4000-8000-000000000001'$$) = 1,
  'a subscribed channel gets the alert');
select t.ok(t.cnt($$select 1 from public.notification_deliveries where notification_id='f0000000-0000-4000-8000-000000000001' and channel_id in ('c2c2c2c2-0000-4000-8000-000000000002','c3c3c3c3-0000-4000-8000-000000000003','c4c4c4c4-0000-4000-8000-000000000004')$$) = 0,
  'unsubscribed, disabled and other-organization channels get nothing');

insert into public.notifications (org_id, type, title) select v, 'workflow_message', 'FYI' from ctx where k='A';
select t.ok(t.cnt($$select 1 from public.notification_deliveries d join public.notifications n on n.id=d.notification_id where n.type='workflow_message'$$) = 0,
  'informational workflow messages are never e-mailed or forwarded unless subscribed');
insert into public.notifications (org_id, type, title) select v, 'task_overdue', '2 tasks are overdue' from ctx where k='A';
select t.ok(t.cnt($$select 1 from public.notification_deliveries d join public.notifications n on n.id=d.notification_id where n.type='task_overdue' and d.channel='email'$$) = 0,
  'overdue e-mails are off by default');
select t.ok(t.cnt($$select 1 from public.notification_deliveries d join public.notifications n on n.id=d.notification_id where n.type='task_overdue' and d.channel='slack'$$) = 1,
  'but a channel that subscribed to overdue tasks receives them');

-- targeted notification: only that person, never shared channels
insert into public.notifications (id, org_id, user_id, type, title) select 'f0000000-0000-4000-8000-000000000002', v, 'aaaaaaaa-9000-0000-0000-000000000003', 'approval_needed', 'Needs you' from ctx where k='A';
select t.ok(t.cnt($$select 1 from public.notification_deliveries where notification_id='f0000000-0000-4000-8000-000000000002' and user_id='aaaaaaaa-9000-0000-0000-000000000003' and channel='email'$$) = 1, 'a targeted notification e-mails that member');
select t.ok(t.cnt($$select 1 from public.notification_deliveries where notification_id='f0000000-0000-4000-8000-000000000002'$$) = 1, 'and nobody else, and no shared channel');

-- preferences
select t.as_user('aaaaaaaa-9000-0000-0000-000000000002');
insert into public.notification_preferences (org_id, user_id, email_workflow_failed) select v, 'aaaaaaaa-9000-0000-0000-000000000002', false from ctx where k='A';
select t.as_service();
insert into public.notifications (id, org_id, type, title) select 'f0000000-0000-4000-8000-000000000003', v, 'workflow_failed', 'Again' from ctx where k='A';
select t.ok(t.cnt($$select 1 from public.notification_deliveries where notification_id='f0000000-0000-4000-8000-000000000003' and channel='email' and user_id='aaaaaaaa-9000-0000-0000-000000000002'$$) = 0, 'a member who turned an e-mail off is not e-mailed');
select t.ok(t.cnt($$select 1 from public.notification_deliveries where notification_id='f0000000-0000-4000-8000-000000000003' and channel='email'$$) = 2, 'the others still are');

-- duplicate protection
select t.throws($$insert into public.notification_deliveries (org_id, notification_id, channel, user_id, dedupe_key)
  select v, 'f0000000-0000-4000-8000-000000000003', 'email', 'aaaaaaaa-9000-0000-0000-000000000001', 'f0000000-0000-4000-8000-000000000003:email:aaaaaaaa-9000-0000-0000-000000000001' from ctx where k='A'$$,
  'the same delivery can never be queued twice', '23505');

-- ===== claiming and completing ==================================================
update public.notification_deliveries set next_attempt_at = now() + interval '1 day';  -- park everything...
update public.notification_deliveries set next_attempt_at = now() - interval '1 minute' where notification_id in ('f0000000-0000-4000-8000-000000000001');
create temp table claimed as select * from public.claim_notification_deliveries(50);
grant all on claimed to service_role;
select t.ok((select count(*) from claimed) = 4, 'claim returns the due deliveries (3 e-mails + 1 channel)');
select t.ok((select count(*) from claimed where delivery_channel = 'email' and recipient_email is not null) = 2, 'confirmed addresses are resolved server-side');
select t.ok((select recipient_email from claimed where delivery_user_id = 'aaaaaaaa-9000-0000-0000-000000000004') is null, 'an unconfirmed address is NOT returned (never e-mailed)');
select t.ok((select bool_and(delivery_attempts = 1) from claimed), 'claiming counts the attempt');
select t.ok((select count(*) from public.claim_notification_deliveries(50)) = 0, 'a leased delivery cannot be claimed twice');
select t.ok(t.cnt($$select 1 from public.notification_deliveries where status='sending'$$) = 4, 'claimed rows are marked sending');

select public.complete_notification_delivery(delivery_id, 'sent') from claimed where delivery_channel = 'email' and recipient_email is not null limit 1;
select t.ok(t.cnt($$select 1 from public.notification_deliveries where status='sent' and sent_at is not null$$) = 1, 'completion marks sent');
select public.complete_notification_delivery(delivery_id, 'failed', 'should not apply') from claimed where delivery_id in (select id from public.notification_deliveries where status='sent');
select t.ok(t.cnt($$select 1 from public.notification_deliveries where status='sent' and last_error is null$$) = 1, 'a late or duplicate report cannot change a finished delivery');
select public.complete_notification_delivery(delivery_id, 'skipped', 'email address not verified') from claimed where delivery_user_id = 'aaaaaaaa-9000-0000-0000-000000000004';
select t.ok(t.cnt($$select 1 from public.notification_deliveries where status='skipped' and last_error like '%not verified%'$$) = 1, 'skipped deliveries record why');

select public.complete_notification_delivery(delivery_id, 'sent') from claimed where delivery_channel = 'slack';
select t.ok((select last_status from public.notification_channels where id='c1c1c1c1-0000-4000-8000-000000000001') = 'ok', 'a successful channel send updates the channel status');
-- retry then give up
select public.complete_notification_delivery(delivery_id, 'retry', 'HTTP 503', 60) from claimed where delivery_channel = 'email' and recipient_email is not null and delivery_id not in (select id from public.notification_deliveries where status = 'sent');
select t.ok(t.cnt($$select 1 from public.notification_deliveries where status='pending' and next_attempt_at > now() + interval '30 seconds' and last_error='HTTP 503'$$) = 1, 'a retry is rescheduled with back-off');
update public.notification_deliveries set attempts = 5, status = 'sending' where status = 'pending' and last_error = 'HTTP 503';
select public.complete_notification_delivery(id, 'retry', 'HTTP 503', 60) from public.notification_deliveries where status = 'sending' and attempts = 5;
select t.ok(t.cnt($$select 1 from public.notification_deliveries where status='failed' and attempts=5 and last_error='HTTP 503'$$) = 1, 'after 5 attempts a retry becomes a permanent failure');

-- lease expiry
update public.notification_deliveries set status='sending', attempts=1, next_attempt_at = now() - interval '1 minute' where id = (select id from public.notification_deliveries where status = 'skipped' limit 1);
select t.ok((select count(*) from public.claim_notification_deliveries(50)) = 1 , 'a crashed worker''s lapsed lease is picked up again');
update public.notification_deliveries set status='sending', attempts=5, next_attempt_at = now() - interval '1 minute' where status = 'sending';
select t.ok((select count(*) from public.claim_notification_deliveries(50)) = 0 and t.cnt($$select 1 from public.notification_deliveries where status='failed' and last_error like '%timed out%'$$) >= 1, 'a delivery that keeps timing out is failed, not retried forever');
select t.throws($$select public.complete_notification_delivery('00000000-0000-0000-0000-000000000000', 'maybe')$$, 'unknown outcomes are rejected', '22023');

-- ===== who can call the worker API ==============================================
select t.as_user('aaaaaaaa-9000-0000-0000-000000000001');
select t.throws('select * from public.claim_notification_deliveries(10)', 'clients cannot claim deliveries', '42501');
select t.throws($$select public.complete_notification_delivery(gen_random_uuid(), 'sent')$$, 'clients cannot complete deliveries', '42501');
select t.throws('select public.notify_overdue_tasks()', 'clients cannot run the overdue sweep', '42501');
select t.throws('select public.prune_notification_deliveries()', 'clients cannot prune', '42501');

-- ===== row-level security ========================================================
select t.as_user('aaaaaaaa-9000-0000-0000-000000000003');   -- plain member
select t.ok(t.cnt('select 1 from public.notification_channels') = 0, 'plain members cannot see channel configuration');
select t.ok(t.cnt('select 1 from public.notification_deliveries') = 1 and t.cnt($$select 1 from public.notification_deliveries where user_id='aaaaaaaa-9000-0000-0000-000000000003'$$) = 1, 'members see only their own e-mail deliveries');
select t.throws('select * from public.notification_channel_secrets', 'webhook secrets are unreadable to members', '42501');
select t.as_user('aaaaaaaa-9000-0000-0000-000000000001');   -- owner
select t.throws('select * from public.notification_channel_secrets', 'webhook secrets are unreadable even to owners', '42501');
select t.ok(t.cnt('select 1 from public.notification_channels') = 3, 'admins see their channels (and only their org''s)');
select t.ok(t.cnt('select 1 from public.notification_deliveries') >= 5, 'admins see the organization delivery log');
select t.throws($$insert into public.notification_channels (org_id, kind, name, url_hint) select v, 'slack', 'x', 'h' from ctx where k='A'$$, 'clients cannot create channels (URL validation + encryption happen server-side)', '42501');
select t.throws($$update public.notification_channels set events = array['workflow_failed'] where false$$, 'clients cannot edit channels', '42501');
select t.throws($$insert into public.notification_deliveries (org_id, notification_id, channel, user_id, dedupe_key) values (gen_random_uuid(), gen_random_uuid(), 'email', gen_random_uuid(), 'x')$$, 'clients cannot write deliveries', '42501');
select t.as_user('bbbbbbbb-9000-0000-0000-000000000001');
select t.ok(t.cnt('select 1 from public.notification_channels') = 1 and t.cnt('select 1 from public.notification_deliveries') = 0, 'another organization sees only its own channel and none of these deliveries');

-- preferences: own row only
select t.as_user('aaaaaaaa-9000-0000-0000-000000000003');
insert into public.notification_preferences (org_id, user_id) select v, 'aaaaaaaa-9000-0000-0000-000000000003' from ctx where k='A';
select t.ok(t.cnt('select 1 from public.notification_preferences') = 1, 'a member manages their own preferences');
select t.throws($$insert into public.notification_preferences (org_id, user_id) select v, 'aaaaaaaa-9000-0000-0000-000000000001' from ctx where k='A'$$, 'nobody can set another member''s preferences', '42501');
select t.throws($$insert into public.notification_preferences (org_id, user_id) select v, 'aaaaaaaa-9000-0000-0000-000000000003' from ctx where k='B'$$, 'nor preferences in an organization they are not in', null);
select t.ok(t.affected($q$update public.notification_preferences set email_task_overdue = true where user_id = 'aaaaaaaa-9000-0000-0000-000000000002'$q$) = 0, 'and cannot change them');

-- ===== hooks ====================================================================
-- chat approvals notify; workflow approvals (already announced by the engine) do not
select t.as_service();
insert into public.workflows (id, org_id, name) select 'aaaa0000-0000-4000-8000-0000000000a9', v, 'WF' from ctx where k='A';
insert into public.workflow_versions (org_id, workflow_id, version, definition) select v, 'aaaa0000-0000-4000-8000-0000000000a9', 1, '{"steps":[{"id":"g","type":"approval","summary":"ok?"}]}' from ctx where k='A';
insert into public.workflow_runs (id, org_id, workflow_id, status) select 'eeeeeeee-9000-4000-8000-000000000001', v, 'aaaa0000-0000-4000-8000-0000000000a9', 'waiting_approval' from ctx where k='A';
insert into public.workflow_steps (org_id, run_id, step_key, step_type, status) select v, 'eeeeeeee-9000-4000-8000-000000000001', 'g', 'approval', 'waiting_approval' from ctx where k='A';
create temp table before_n as select count(*) c from public.notifications where type='approval_needed';
grant all on before_n to service_role;
insert into public.approval_requests (org_id, workflow_run_id, workflow_step_key, action_type, summary, payload) select v, 'eeeeeeee-9000-4000-8000-000000000001', 'g', 'workflow.gate', 'ok?', '{}' from ctx where k='A';
select t.ok((select count(*) from public.notifications where type='approval_needed') = (select c from before_n), 'workflow approvals do not create a duplicate notification');
insert into public.approval_requests (org_id, action_type, summary, payload) select v, 'email.send', 'Send reply to Dana', '{}' from ctx where k='A';
select t.ok((select count(*) from public.notifications where type='approval_needed') = (select c from before_n) + 1, 'a chat approval request creates a notification');
select t.ok(t.cnt($$select 1 from public.notifications where type='approval_needed' and body = 'Send reply to Dana'$$) = 1, 'carrying what needs approving');
select t.ok(t.cnt($$select 1 from public.notification_deliveries d join public.notifications n on n.id=d.notification_id where n.body='Send reply to Dana' and d.channel='teams'$$) = 1, 'and is forwarded to the approvals channel');

-- overdue sweep
insert into public.tasks (org_id, title, due_at, status) select v, 'Late 1', now() - interval '3 days', 'todo' from ctx where k='A';
insert into public.tasks (org_id, title, due_at, status) select v, 'Late 2', now() - interval '2 days', 'in_progress' from ctx where k='A';
insert into public.tasks (org_id, title, due_at, status) select v, 'Done late', now() - interval '2 days', 'done' from ctx where k='A';
insert into public.tasks (org_id, title, due_at, status) select v, 'Future', now() + interval '2 days', 'todo' from ctx where k='A';
insert into public.tasks (org_id, title, due_at, status) select v, 'B late', now() - interval '1 day', 'todo' from ctx where k='B';
delete from public.notifications where type = 'task_overdue';
select t.ok(public.notify_overdue_tasks() = 3, 'only open, past-due tasks are swept (2 in org A, 1 in org B)');
select t.ok(t.cnt($$select 1 from public.notifications where type='task_overdue'$$) = 2, 'one summary per organization');
select t.ok(t.cnt($$select 1 from public.notifications n join public.organizations o on o.id=n.org_id where n.type='task_overdue' and o.name='Org A' and n.title='2 tasks are overdue' and n.body like '%Late 1%' and n.body like '%Late 2%' and n.body not like '%B late%' and n.body not like '%Future%'$$) = 1, 'the summary names the tasks and never another organization''s');
select t.ok(public.notify_overdue_tasks() = 0 and t.cnt($$select 1 from public.notifications where type='task_overdue'$$) = 2, 'each task is announced only once');
select t.ok(t.cnt($$select 1 from public.task_history h join public.tasks k on k.id=h.task_id where k.title='Late 1' and h.event='updated'$$) = 0, 'the bookkeeping does not pollute task history');
update public.tasks set due_at = now() - interval '1 hour' where title = 'Late 1';
select t.ok(public.notify_overdue_tasks() = 1, 'a task whose due date changes can be announced again');
update public.tasks set status = 'done' where title = 'Late 2';
update public.tasks set status = 'todo' where title = 'Late 2';
select t.ok(public.notify_overdue_tasks() = 1, 'and so can one that was reopened');
insert into public.tasks (org_id, title, due_at) select v, 'Late ' || g, now() - interval '5 days' from ctx, generate_series(1, 9) g where k='A';
delete from public.notifications where type = 'task_overdue';
select public.notify_overdue_tasks();
select t.ok(t.cnt($$select 1 from public.notifications where type='task_overdue' and title='9 tasks are overdue' and body like '%…and 4 more'$$) = 1, 'a large backlog becomes one short summary');

-- ===== pruning and cascades ========================================================
update public.notification_deliveries set created_at = now() - interval '40 days' where status = 'sent';
select t.ok(public.prune_notification_deliveries() >= 1, 'old delivered rows are pruned');
delete from public.notification_channels where id = 'c1c1c1c1-0000-4000-8000-000000000001';
select t.ok(t.cnt($$select 1 from public.notification_deliveries where channel_id='c1c1c1c1-0000-4000-8000-000000000001'$$) = 0
        and t.cnt($$select 1 from public.notification_channel_secrets$$) = 0, 'deleting a channel removes its deliveries and its secret');
rollback;
