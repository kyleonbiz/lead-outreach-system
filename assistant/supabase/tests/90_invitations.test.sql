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

-- people (invitee has a mixed-case address on purpose)
insert into auth.users (id, email, email_confirmed_at) values
  ('aaaaaaaa-a000-0000-0000-000000000001', 'owner@a.test', now()),
  ('aaaaaaaa-a000-0000-0000-000000000002', 'admin@a.test', now()),
  ('aaaaaaaa-a000-0000-0000-000000000003', 'member@a.test', now()),
  ('bbbbbbbb-a000-0000-0000-000000000001', 'owner@b.test', now()),
  ('cccccccc-a000-0000-0000-000000000001', 'Invitee@X.test', now()),
  ('cccccccc-a000-0000-0000-000000000002', 'unconfirmed@x.test', null),
  ('cccccccc-a000-0000-0000-000000000003', 'stranger@x.test', now()),
  ('cccccccc-a000-0000-0000-000000000004', 'expired@x.test', now()),
  ('cccccccc-a000-0000-0000-000000000005', 'revoked@x.test', now());
create temp table ctx(k text primary key, v uuid);
grant all on ctx to authenticated, service_role;
select t.as_user('aaaaaaaa-a000-0000-0000-000000000001');
insert into ctx select 'A', public.create_organization('Org A');
insert into public.organization_members (org_id, user_id, role) select v, 'aaaaaaaa-a000-0000-0000-000000000002', 'admin' from ctx where k='A';
insert into public.organization_members (org_id, user_id, role) select v, 'aaaaaaaa-a000-0000-0000-000000000003', 'member' from ctx where k='A';
select t.as_user('bbbbbbbb-a000-0000-0000-000000000001');
insert into ctx select 'B', public.create_organization('Org B');

-- tokens are random 256-bit strings in production; any 20+ character string works for the tests
-- T1 invitee/admin   T2 unconfirmed   T3 expired   T4 revoked   T5 org B   T6 stranger (already a member)

-- ===== no plaintext token anywhere ============================================
select t.ok(not exists (select 1 from information_schema.columns where table_schema='public' and table_name='organization_invitations'
  and column_name ~* 'token' and column_name <> 'token_hash'), 'the table has no plaintext token column');

-- ===== who may create ==========================================================
select t.as_service();
select t.throws($$select public.create_invitation('aaaaaaaa-a000-0000-0000-000000000002', (select v from ctx where k='A'), 'new@x.test', 'member', t.h('x-admin-xxxxxxxxxxxxxxxxxxxxxxxx'))$$, 'an admin cannot invite (owners only)', '42501');
select t.throws($$select public.create_invitation('aaaaaaaa-a000-0000-0000-000000000003', (select v from ctx where k='A'), 'new@x.test', 'member', t.h('x-member-xxxxxxxxxxxxxxxxxxxxxx'))$$, 'a member cannot invite', '42501');
select t.throws($$select public.create_invitation('bbbbbbbb-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'new@x.test', 'member', t.h('x-otherorg-xxxxxxxxxxxxxxxxxxxxx'))$$, 'another organization''s owner cannot invite into this one', '42501');
select t.throws($$select public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'new@x.test', 'owner', t.h('x-owner-xxxxxxxxxxxxxxxxxxxxxxxx'))$$, 'an invitation can never grant the owner role', '22023');
select t.throws($$select public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'new@x.test', 'superuser', t.h('x-su-xxxxxxxxxxxxxxxxxxxxxxxxxxxx'))$$, 'unknown roles are refused', '22023');
select t.throws($$select public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'member@a.test', 'admin', t.h('x-existing-xxxxxxxxxxxxxxxxxxxxx'))$$, 'inviting someone who is already a member is refused', '23505');
select t.throws($$select public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'not-an-email', 'member', t.h('x-bad-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx'))$$, 'a malformed address is refused', '23514');
select t.throws($$select public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'a@x.test,b@x.test', 'member', t.h('x-multi-xxxxxxxxxxxxxxxxxxxxxxxxxxxx'))$$, 'several addresses in one invitation are refused', '23514');
select t.throws($$select public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'new@x.test', 'member', 'plaintext-token-is-not-a-hash')$$, 'only a SHA-256 hash can be stored', '23514');

select t.as_user('aaaaaaaa-a000-0000-0000-000000000001');   -- even the owner, as a client
select t.throws($$select public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'x@x.test', 'member', t.h('x-client-xxxxxxxxxxxxxxxxxxxxxxxxxx'))$$, 'clients cannot call create_invitation (the server holds the token)', '42501');
select t.throws($$insert into public.organization_invitations (org_id, email, role, token_hash, expires_at) select v, 'x@x.test', 'owner', t.h('direct-direct-direct-direct'), now() + interval '1 day' from ctx where k='A'$$, 'clients cannot insert invitations directly', '42501');
select t.throws($$update public.organization_invitations set role = 'owner'$$, 'clients cannot update invitations', '42501');
select t.throws($$delete from public.organization_invitations$$, 'clients cannot delete invitations', '42501');
select t.throws($$select token_hash from public.organization_invitations$$, 'the token hash is not readable by any client', '42501');

-- ===== create the invitations used below ===========================================
select t.as_service();
insert into ctx select 'inv1', public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), '  Invitee@X.test ', 'admin', t.h('T1-invitee-admin-aaaaaaaaaaaaaaaaaaaaaaaaaa'));
insert into ctx select 'inv2', public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'unconfirmed@x.test', 'member', t.h('T2-unconfirmed-aaaaaaaaaaaaaaaaaaaaaaaaaa'));
insert into ctx select 'inv3', public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'expired@x.test', 'member', t.h('T3-expired-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
insert into ctx select 'inv4', public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'revoked@x.test', 'member', t.h('T4-revoked-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
insert into ctx select 'inv6', public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'stranger@x.test', 'admin', t.h('T6-stranger-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
select t.as_user('bbbbbbbb-a000-0000-0000-000000000001');
select t.as_service();
insert into ctx select 'inv5', public.create_invitation('bbbbbbbb-a000-0000-0000-000000000001', (select v from ctx where k='B'), 'invitee@x.test', 'member', t.h('T5-orgB-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));

select t.ok((select email from public.organization_invitations where id=(select v from ctx where k='inv1')) = 'invitee@x.test', 'the address is stored lower-cased and trimmed');
select t.ok((select expires_at from public.organization_invitations where id=(select v from ctx where k='inv1')) between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour', 'it expires in 7 days by default');
select t.ok(t.cnt($$select 1 from public.action_logs where action='invitation.created' and summary = 'Invited invitee@x.test as admin'$$) = 1, 'creation is audited');
-- expire inv3 (a real clock would do this on its own)
update public.organization_invitations set created_at = now() - interval '10 days', expires_at = now() - interval '3 days' where id = (select v from ctx where k='inv3');

-- revoke inv4 as its owner
select t.as_user('aaaaaaaa-a000-0000-0000-000000000002');
select t.throws($$select public.revoke_invitation((select v from ctx where k='inv4'))$$, 'an admin cannot revoke', 'P0002');
select t.as_user('bbbbbbbb-a000-0000-0000-000000000001');
select t.throws($$select public.revoke_invitation((select v from ctx where k='inv4'))$$, 'another organization''s owner cannot revoke (and cannot tell it exists)', 'P0002');
select t.throws($$select public.revoke_invitation('00000000-0000-0000-0000-000000000000')$$, 'an unknown id looks exactly the same', 'P0002');
select t.as_user('aaaaaaaa-a000-0000-0000-000000000001');
select t.ok(public.revoke_invitation((select v from ctx where k='inv4')) is true, 'the owner can revoke');
select t.ok(public.revoke_invitation((select v from ctx where k='inv4')) is false, 'revoking twice changes nothing');
select t.ok(t.cnt($$select 1 from public.action_logs where action='invitation.revoked'$$) = 1, 'revocation is audited once');

-- ===== visibility ==============================================================
select t.ok(t.cnt('select 1 from public.organization_invitations') = 5, 'the owner sees their organization''s invitations (not org B''s)');
select t.as_user('aaaaaaaa-a000-0000-0000-000000000002');
select t.ok(t.cnt('select 1 from public.organization_invitations') = 0, 'admins do not see invitations');
select t.as_user('aaaaaaaa-a000-0000-0000-000000000003');
select t.ok(t.cnt('select 1 from public.organization_invitations') = 0, 'members do not');
select t.as_user('bbbbbbbb-a000-0000-0000-000000000001');
select t.ok(t.cnt('select 1 from public.organization_invitations') = 1, 'org B''s owner sees only org B''s invitation');

-- ===== accepting: every way it must fail =========================================
select t.as_anon();
select t.throws($$select public.accept_invitation('T1-invitee-admin-aaaaaaaaaaaaaaaaaaaaaaaaaa')$$, 'anonymous callers cannot accept', '42501');

select t.as_user('cccccccc-a000-0000-0000-000000000003');   -- stranger holding invitee's link
select t.throws($$select public.accept_invitation('T1-invitee-admin-aaaaaaaaaaaaaaaaaaaaaaaaaa')$$, 'someone with a different address cannot use the link', '42501');
select t.ok(t.cnt('select 1 from public.organizations') = 0, 'and gained no access');
select t.throws($$select public.accept_invitation('this-is-not-a-real-token-at-all-xxxxxx')$$, 'a wrong token is refused generically', 'P0002');
select t.throws($$select public.accept_invitation('short')$$, 'an implausibly short token is refused', 'P0002');
select t.throws($$select public.accept_invitation(null)$$, 'a null token is refused', 'P0002');

select t.as_user('cccccccc-a000-0000-0000-000000000002');   -- unconfirmed address
select t.throws($$select public.accept_invitation('T2-unconfirmed-aaaaaaaaaaaaaaaaaaaaaaaaaa')$$, 'an unconfirmed e-mail address cannot accept even the right link', '42501');

select t.as_user('cccccccc-a000-0000-0000-000000000004');
select t.throws($$select public.accept_invitation('T3-expired-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')$$, 'an expired invitation is refused', 'P0002');
select t.as_user('cccccccc-a000-0000-0000-000000000005');
select t.throws($$select public.accept_invitation('T4-revoked-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')$$, 'a revoked invitation is refused', 'P0002');

select t.as_user('aaaaaaaa-a000-0000-0000-000000000003');   -- an existing member of a different invite flow
select t.throws($$select public.accept_invitation('T5-orgB-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')$$, 'an invitation to org B cannot be used by someone with another address', '42501');

-- ===== accepting: success, then replay ===========================================
select t.as_user('cccccccc-a000-0000-0000-000000000001');   -- Invitee@X.test: matches case-insensitively
select t.ok((public.accept_invitation('T1-invitee-admin-aaaaaaaaaaaaaaaaaaaaaaaaaa') ->> 'role') = 'admin', 'the matching confirmed address joins with exactly the invited role');
select t.ok(t.cnt('select 1 from public.organizations') = 1, 'and can now see the organization');
select t.ok((select role from public.organization_members where user_id='cccccccc-a000-0000-0000-000000000001') = 'admin', 'membership is admin, not owner');
select t.throws($$select public.accept_invitation('T1-invitee-admin-aaaaaaaaaaaaaaaaaaaaaaaaaa')$$, 'replay: the same link cannot be used twice', 'P0002');
select t.as_user('cccccccc-a000-0000-0000-000000000003');
select t.throws($$select public.accept_invitation('T1-invitee-admin-aaaaaaaaaaaaaaaaaaaaaaaaaa')$$, 'replay by someone else also fails', 'P0002');

select t.as_service();
select t.ok(t.cnt($$select 1 from public.organization_invitations where id=(select v from ctx where k='inv1') and accepted_at is not null and accepted_by='cccccccc-a000-0000-0000-000000000001'$$) = 1, 'the invitation records who accepted and when');
select t.ok(t.cnt($$select 1 from public.action_logs where action='invitation.accepted' and user_id='cccccccc-a000-0000-0000-000000000001'$$) = 1, 'acceptance is audited');

-- the same person, invited to org B, joins B only as 'member' and stays admin in A
select t.as_user('cccccccc-a000-0000-0000-000000000001');
select t.ok((public.accept_invitation('T5-orgB-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') ->> 'role') = 'member', 'a second organization''s invitation grants only its own role');
select t.ok(t.cnt('select 1 from public.organizations') = 2, 'both memberships exist independently');
select t.ok((select role from public.organization_members m join ctx c on c.k='A' and c.v=m.org_id where m.user_id='cccccccc-a000-0000-0000-000000000001') = 'admin', 'the role in org A is unchanged');

-- an invitee who joined another way in the meantime cannot double-join
select t.as_user('aaaaaaaa-a000-0000-0000-000000000001');
insert into public.organization_members (org_id, user_id, role) select v, 'cccccccc-a000-0000-0000-000000000003', 'member' from ctx where k='A';
select t.as_user('cccccccc-a000-0000-0000-000000000003');
select t.throws($$select public.accept_invitation('T6-stranger-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')$$, 'an existing member cannot use an invitation to change their role', '23505');
select t.ok((select role from public.organization_members m join ctx c on c.k='A' and c.v=m.org_id where m.user_id='cccccccc-a000-0000-0000-000000000003') = 'member', 'and keeps the role they have');

-- admins (even one created through an invitation) still cannot invite
select t.as_service();
select t.throws($$select public.create_invitation('cccccccc-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'friend@x.test', 'member', t.h('x-newadmin-xxxxxxxxxxxxxxxxxxxxxxxx'))$$, 'an invited admin cannot invite further people', '42501');

-- ===== re-inviting replaces the old link ===========================================
insert into ctx select 'inv7a', public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'newhire@x.test', 'member', t.h('T7-first-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
insert into ctx select 'inv7b', public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'NewHire@x.test', 'admin', t.h('T7-second-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
select t.ok(t.cnt($$select 1 from public.organization_invitations where email='newhire@x.test' and revoked_at is null and accepted_at is null$$) = 1, 'only one live invitation per address');
select t.ok((select revoked_at from public.organization_invitations where id=(select v from ctx where k='inv7a')) is not null, 'the earlier link was revoked');
insert into auth.users (id, email, email_confirmed_at) values ('cccccccc-a000-0000-0000-000000000007', 'newhire@x.test', now());
select t.as_user('cccccccc-a000-0000-0000-000000000007');
select t.throws($$select public.accept_invitation('T7-first-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')$$, 'the superseded link no longer works', 'P0002');
select t.ok((public.accept_invitation('T7-second-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') ->> 'role') = 'admin', 'the new link does');

-- ===== member directory ==============================================================
select t.as_user('aaaaaaaa-a000-0000-0000-000000000003');   -- plain member
select t.ok(t.cnt($$select 1 from public.org_members((select v from ctx where k='A'))$$) >= 4, 'members see the whole team');
select t.ok(t.cnt($$select 1 from public.org_members((select v from ctx where k='A')) where email is not null$$) = 0, 'but not their e-mail addresses');
select t.ok(t.cnt($$select 1 from public.org_members((select v from ctx where k='B'))$$) = 0, 'and nothing about an organization they are not in');
select t.as_user('aaaaaaaa-a000-0000-0000-000000000001');
select t.ok(t.cnt($$select 1 from public.org_members((select v from ctx where k='A')) where email is not null$$) >= 4, 'owners see e-mail addresses');
select t.ok((select role from public.org_members((select v from ctx where k='A')) limit 1) = 'owner', 'sorted owners first');
select t.as_anon();
select t.throws($$select * from public.org_members('00000000-0000-0000-0000-000000000000')$$, 'anonymous callers cannot list members', '42501');

-- ===== limits ========================================================================
select t.as_service();
update public.organization_invitations set revoked_at = now() where org_id = (select v from ctx where k='A') and accepted_at is null and revoked_at is null;
insert into public.organization_invitations (org_id, email, role, token_hash, invited_by, expires_at)
  select (select v from ctx where k='A'), 'cap' || g || '@x.test', 'member', t.h('cap-' || g || '-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'aaaaaaaa-a000-0000-0000-000000000001', now() + interval '7 days'
  from generate_series(1, 50) g;
select t.throws($$select public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'one-too-many@x.test', 'member', t.h('x-cap-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'))$$, 'at most 50 pending invitations per organization', '53400');
update public.organization_invitations set revoked_at = now() where org_id = (select v from ctx where k='A') and accepted_at is null and revoked_at is null;
-- 56 invitations exist in the last 24 hours so far; add enough already-revoked ones to reach 100
insert into public.organization_invitations (org_id, email, role, token_hash, invited_by, expires_at, revoked_at)
  select (select v from ctx where k='A'), 'old' || g || '@x.test', 'member', t.h('old-' || g || '-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'aaaaaaaa-a000-0000-0000-000000000001', now() + interval '7 days', now()
  from generate_series(1, 44) g;
select t.throws($$select public.create_invitation('aaaaaaaa-a000-0000-0000-000000000001', (select v from ctx where k='A'), 'daily@x.test', 'member', t.h('x-daily-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'))$$, 'and at most 100 new invitations per day (mail-abuse guard)', '53400');

-- ===== lifecycle ======================================================================
delete from auth.users where id = 'cccccccc-a000-0000-0000-000000000001';
select t.ok((select accepted_by from public.organization_invitations where id=(select v from ctx where k='inv1')) is null, 'deleting the invitee''s account keeps the history without a dangling reference');
delete from public.organizations where id = (select v from ctx where k='A');
select t.ok(t.cnt($$select 1 from public.organization_invitations where org_id=(select v from ctx where k='B')$$) = 1, 'deleting an organization removes only its own invitations');
rollback;
