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
create or replace function t.affected(sql text) returns bigint language plpgsql as $$
declare n bigint; begin execute sql; get diagnostics n = row_count; return n; end $$;
create or replace function t.h(tok text) returns text language sql as $$ select encode(sha256(convert_to(tok, 'UTF8')), 'hex') $$;
grant execute on function t.h(text), t.cnt(text), t.affected(text) to authenticated, anon, service_role;

-- people
insert into auth.users (id, email, email_confirmed_at) values
  ('aaaaaaaa-b000-0000-0000-000000000001', 'Owner@A.test', now()),
  ('aaaaaaaa-b000-0000-0000-000000000002', 'admin@a.test', now()),
  ('aaaaaaaa-b000-0000-0000-000000000003', 'member@a.test', now()),
  ('bbbbbbbb-b000-0000-0000-000000000001', 'owner@b.test', now()),
  ('cccccccc-b000-0000-0000-000000000001', 'solo@c.test', now());
update public.profiles set full_name = 'Olivia Owner' where id = 'aaaaaaaa-b000-0000-0000-000000000001';
update public.profiles set full_name = 'Max Member' where id = 'aaaaaaaa-b000-0000-0000-000000000003';
create temp table ctx(k text primary key, v uuid);
grant all on ctx to authenticated, service_role;
select t.as_user('aaaaaaaa-b000-0000-0000-000000000001');
insert into ctx select 'A', public.create_organization('Org A');
insert into public.organization_members (org_id, user_id, role) select v, 'aaaaaaaa-b000-0000-0000-000000000002', 'admin' from ctx where k='A';
insert into public.organization_members (org_id, user_id, role) select v, 'aaaaaaaa-b000-0000-0000-000000000003', 'member' from ctx where k='A';
select t.as_user('bbbbbbbb-b000-0000-0000-000000000001');
insert into ctx select 'B', public.create_organization('Org B');
select t.as_user('cccccccc-b000-0000-0000-000000000001');
insert into ctx select 'C', public.create_organization('Org C (solo)');

-- ===== ownership transfer =======================================================
select t.as_user('aaaaaaaa-b000-0000-0000-000000000002');   -- admin
select t.throws($$select public.transfer_ownership((select v from ctx where k='A'), 'aaaaaaaa-b000-0000-0000-000000000003')$$, 'an admin cannot transfer ownership', '42501');
select t.as_user('aaaaaaaa-b000-0000-0000-000000000003');   -- member
select t.throws($$select public.transfer_ownership((select v from ctx where k='A'), 'aaaaaaaa-b000-0000-0000-000000000003')$$, 'a member cannot make themselves owner', '42501');
select t.as_user('bbbbbbbb-b000-0000-0000-000000000001');   -- another org's owner
select t.throws($$select public.transfer_ownership((select v from ctx where k='A'), 'bbbbbbbb-b000-0000-0000-000000000001')$$, 'another organization''s owner cannot take over this one', '42501');
select t.throws($$select public.transfer_ownership('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-b000-0000-0000-000000000001')$$, 'an unknown organization looks the same', '42501');
select t.as_anon();
select t.throws($$select public.transfer_ownership((select v from ctx where k='A'), 'aaaaaaaa-b000-0000-0000-000000000003')$$, 'anonymous callers cannot transfer', '42501');

select t.as_user('aaaaaaaa-b000-0000-0000-000000000001');   -- the owner
select t.throws($$select public.transfer_ownership((select v from ctx where k='A'), 'aaaaaaaa-b000-0000-0000-000000000001')$$, 'transferring to yourself is refused', '22023');
select t.throws($$select public.transfer_ownership((select v from ctx where k='A'), 'bbbbbbbb-b000-0000-0000-000000000001')$$, 'the new owner must already be a member (no outsiders)', '22023');
select t.throws($$select public.transfer_ownership((select v from ctx where k='A'), gen_random_uuid())$$, 'an unknown person is refused', '22023');

select public.transfer_ownership((select v from ctx where k='A'), 'aaaaaaaa-b000-0000-0000-000000000003');
select t.ok((select role from public.organization_members where user_id='aaaaaaaa-b000-0000-0000-000000000003' and org_id=(select v from ctx where k='A')) = 'owner', 'the member became an owner');
select t.ok((select role from public.organization_members where user_id='aaaaaaaa-b000-0000-0000-000000000001' and org_id=(select v from ctx where k='A')) = 'owner', 'without step-down the previous owner stays owner (shared ownership)');
select t.ok(t.cnt($$select 1 from public.action_logs where action='ownership.transferred' and summary = 'Ownership shared with Max Member'$$) = 1, 'the transfer is audited with the new owner''s name');

select public.transfer_ownership((select v from ctx where k='A'), 'aaaaaaaa-b000-0000-0000-000000000002', true);
select t.ok((select role from public.organization_members where user_id='aaaaaaaa-b000-0000-0000-000000000001' and org_id=(select v from ctx where k='A')) = 'admin', 'stepping down makes the previous owner an admin');
select t.ok(t.cnt($$select 1 from public.organization_members where org_id=(select v from ctx where k='A') and role='owner'$$) = 2, 'the organization still has owners (Max and the promoted admin)');
select t.ok(t.cnt($$select 1 from public.action_logs where action='ownership.transferred' and summary like '%stepped down%'$$) = 1, 'stepping down is recorded');
select t.throws($$select public.transfer_ownership((select v from ctx where k='A'), 'aaaaaaaa-b000-0000-0000-000000000003')$$, 'having stepped down, they can no longer transfer', '42501');
select t.as_user('bbbbbbbb-b000-0000-0000-000000000001');
select t.ok(t.cnt($$select 1 from public.action_logs where action='ownership.transferred'$$) = 0, 'other organizations cannot see this audit trail');

-- ===== deletion plan ===============================================================
-- put the original owner back as the sole owner of A for the "blocked" case, and give people more memberships
select t.as_service();
update public.organization_members set role = 'owner' where org_id=(select v from ctx where k='A') and user_id = 'aaaaaaaa-b000-0000-0000-000000000001';  -- restore first: an org may never have zero owners
update public.organization_members set role = 'member' where org_id=(select v from ctx where k='A') and user_id in ('aaaaaaaa-b000-0000-0000-000000000003', 'aaaaaaaa-b000-0000-0000-000000000002');
insert into public.organization_members (org_id, user_id, role) select v, 'aaaaaaaa-b000-0000-0000-000000000002', 'member' from ctx where k='B';
select t.ok((select plan from public.account_deletion_plan('aaaaaaaa-b000-0000-0000-000000000001') where org_id=(select v from ctx where k='A')) = 'blocked', 'the only owner of an organization with other members is blocked');
select t.ok((select plan from public.account_deletion_plan('cccccccc-b000-0000-0000-000000000001')) = 'delete_org', 'the only member would take the organization with them');
select t.ok((select plan from public.account_deletion_plan('aaaaaaaa-b000-0000-0000-000000000002') where org_id=(select v from ctx where k='A')) = 'leave', 'an ordinary member simply leaves');
select t.ok((select plan from public.account_deletion_plan('aaaaaaaa-b000-0000-0000-000000000002') where org_id=(select v from ctx where k='B')) = 'leave', 'and so does a member of another organization');
select t.ok((select member_count from public.account_deletion_plan('aaaaaaaa-b000-0000-0000-000000000001')) = 3 and (select owner_count from public.account_deletion_plan('aaaaaaaa-b000-0000-0000-000000000001')) = 1, 'the plan reports member and owner counts');
select t.ok(t.cnt($$select 1 from public.account_deletion_plan('dddddddd-0000-0000-0000-000000000000')$$) = 0, 'an unknown user has nothing to delete');

-- the plan agrees with what the database would actually do
select t.throws($$delete from auth.users where id = 'aaaaaaaa-b000-0000-0000-000000000001'$$, 'deleting a "blocked" user is refused by the last-owner guard', '23514');

-- co-owner => leave
update public.organization_members set role = 'owner' where org_id=(select v from ctx where k='A') and user_id = 'aaaaaaaa-b000-0000-0000-000000000003';
select t.ok((select plan from public.account_deletion_plan('aaaaaaaa-b000-0000-0000-000000000001')) = 'leave', 'once there is a co-owner the plan becomes "leave"');

select t.as_user('aaaaaaaa-b000-0000-0000-000000000001');
select t.throws($$select * from public.account_deletion_plan('aaaaaaaa-b000-0000-0000-000000000001')$$, 'clients cannot ask for deletion plans', '42501');
select t.throws($$select public.scrub_user_log_text('aaaaaaaa-b000-0000-0000-000000000001', 'owner@a.test')$$, 'clients cannot scrub logs', '42501');

-- ===== scrubbing the audit trail =====================================================
select t.as_service();
insert into public.action_logs (org_id, user_id, actor_type, category, action, status, summary, error) select v, 'aaaaaaaa-b000-0000-0000-000000000001', 'user', 'audit', 'x.test', 'success', 'Owner@A.test joined; also owner@a.test again', 'failed for OWNER@A.TEST' from ctx where k='A';
insert into public.action_logs (org_id, user_id, actor_type, category, action, status, summary) select v, 'aaaaaaaa-b000-0000-0000-000000000003', 'user', 'audit', 'x.other', 'success', 'mentions owner@a.test but was written by someone else' from ctx where k='A';
select t.ok(public.scrub_user_log_text('aaaaaaaa-b000-0000-0000-000000000001', 'Owner@A.test') = 1, 'one entry written by the user was scrubbed');
select t.ok((select summary from public.action_logs where action='x.test') = '[deleted account] joined; also [deleted account] again', 'both spellings of the address were replaced');
select t.ok((select error from public.action_logs where action='x.test') = 'failed for [deleted account]', 'including a third capitalization, in the error text, keeping the rest of the sentence');
select t.ok(public.scrub_user_log_text('aaaaaaaa-b000-0000-0000-000000000001', 'a.b+c@d.test') = 0, 'regex metacharacters in an address are matched literally (and match nothing here)');
select t.ok((select summary from public.action_logs where action='x.other') like '%owner@a.test%', 'entries written by other people are not touched');
select t.ok(public.scrub_user_log_text('aaaaaaaa-b000-0000-0000-000000000001', null) = 0 and public.scrub_user_log_text('aaaaaaaa-b000-0000-0000-000000000001', 'x') = 0, 'a missing or trivial address is a no-op (it cannot blank out text)');

-- ===== what a deletion leaves behind ===================================================
select t.as_user('aaaaaaaa-b000-0000-0000-000000000003');
insert into public.tasks (org_id, title) select v, 'Max''s task' from ctx where k='A';
insert into public.assistant_conversations (org_id, title) select v, 'Max chat' from ctx where k='A';
insert into public.assistant_messages (org_id, conversation_id, role, content) select org_id, id, 'user', 'private words' from public.assistant_conversations;
insert into public.notification_preferences (org_id, user_id) select v, 'aaaaaaaa-b000-0000-0000-000000000003' from ctx where k='A';
select t.as_service();
insert into public.organization_invitations (org_id, email, role, token_hash, invited_by, expires_at)
  select v, 'later@x.test', 'member', t.h('inv-by-max-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'aaaaaaaa-b000-0000-0000-000000000003', now() + interval '3 days' from ctx where k='A';
insert into public.action_logs (org_id, user_id, actor_type, category, action, status, summary) select v, 'aaaaaaaa-b000-0000-0000-000000000003', 'user', 'audit', 'x.max', 'success', 'Max did a thing' from ctx where k='A';

delete from auth.users where id = 'aaaaaaaa-b000-0000-0000-000000000003';
select t.ok(t.cnt($$select 1 from public.organizations where id=(select v from ctx where k='A')$$) = 1, 'the organization survives a member''s deletion');
select t.ok(t.cnt($$select 1 from public.tasks where title='Max''s task' and created_by is null$$) = 1, 'their tasks stay with the organization, no longer tied to them');
select t.ok(t.cnt($$select 1 from public.assistant_conversations where title='Max chat'$$) = 0 and t.cnt($$select 1 from public.assistant_messages where content='private words'$$) = 0, 'their private conversations and messages are deleted');
select t.ok(t.cnt($$select 1 from public.notification_preferences where user_id='aaaaaaaa-b000-0000-0000-000000000003'$$) = 0 and t.cnt($$select 1 from public.profiles where id='aaaaaaaa-b000-0000-0000-000000000003'$$) = 0, 'their preferences and profile are deleted');
select t.ok(t.cnt($$select 1 from public.organization_members where user_id='aaaaaaaa-b000-0000-0000-000000000003'$$) = 0, 'their membership is gone');
select t.ok(t.cnt($$select 1 from public.organization_invitations where email='later@x.test' and invited_by is null$$) = 1, 'invitations they created remain, without pointing at them');
select t.ok(t.cnt($$select 1 from public.action_logs where action='x.max' and user_id is null$$) = 1, 'the audit trail remains, detached from their identity');
select t.ok(t.cnt($$select 1 from public.organization_members where org_id=(select v from ctx where k='A') and role='owner'$$) >= 1, 'the organization still has an owner');

-- a solo organization is deleted completely with its data, then the person can be deleted
insert into public.tasks (org_id, title) select v, 'solo task' from ctx where k='C';
insert into public.workflows (org_id, name) select v, 'solo wf' from ctx where k='C';
insert into public.notification_channels (org_id, kind, name, url_hint) select v, 'slack', 'solo hook', 'h' from ctx where k='C';
insert into public.organization_invitations (org_id, email, role, token_hash, invited_by, expires_at) select v, 'z@x.test', 'member', t.h('solo-inv-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'cccccccc-b000-0000-0000-000000000001', now() + interval '1 day' from ctx where k='C';
delete from public.organizations where id = (select v from ctx where k='C');
select t.ok(t.cnt($$select 1 from public.tasks where title='solo task'$$) + t.cnt($$select 1 from public.workflows where name='solo wf'$$) + t.cnt($$select 1 from public.notification_channels where name='solo hook'$$) + t.cnt($$select 1 from public.organization_invitations where email='z@x.test'$$) = 0, 'deleting an organization removes its tasks, workflows, channels and invitations');
delete from auth.users where id = 'cccccccc-b000-0000-0000-000000000001';
select t.ok(t.cnt($$select 1 from auth.users where id='cccccccc-b000-0000-0000-000000000001'$$) = 0, 'and then the account itself can be deleted');
select t.ok(t.cnt($$select 1 from public.organizations where id=(select v from ctx where k='B')$$) = 1, 'other organizations are untouched');
rollback;
