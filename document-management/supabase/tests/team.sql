-- Team management, share-link revocation/audit and stale-upload cleanup.
-- Included from rls.sql (\ir) so it shares the helpers and psql variables.
-- State on entry: workspace A has alice=owner, erin=admin, dave=editor, carol=viewer;
-- workspace B has bob=owner; doc ...0001 has share links 'hash-ok' (live) and 'hash-expired' by dave.

\set frank '''00000000-0000-4000-8000-0000000000f1'''
\set gina  '''00000000-0000-4000-8000-0000000000f2'''
\set heidi '''00000000-0000-4000-8000-0000000000f3'''
\set ivan  '''00000000-0000-4000-8000-0000000000f4'''
\set judy  '''00000000-0000-4000-8000-0000000000f5'''
\set doc1  '''10000000-0000-4000-8000-000000000001'''

reset role;
insert into auth.users (id, email, email_confirmed_at) values
  (:frank, 'Frank@A.test', now()), (:gina, 'gina@a.test', null), (:heidi, 'heidi@x.test', now()),
  (:ivan, 'ivan@a.test', now()), (:judy, 'judy@a.test', now());
insert into public.workspace_members (workspace_id, user_id, role, display_name, email) values
  (:'wsa', :ivan, 'admin', 'Ivan', 'ivan@a.test'),
  (:'wsa', :judy, 'editor', 'Judy', 'judy@a.test');

-- =============================================================== share links
select t.as_user(:dave);
select t.ok('editor lists only live links for a document',
  (select count(*) from public.dms_list_share_links(:'wsa', :doc1)) = 1);
select t.fails('editor cannot edit a share link row directly',
  $q$update public.document_share_links set expires_at = now() + interval '30 days' where token_hash = 'hash-ok'$q$, 'permission denied');
select t.as_user(:carol);
select t.ok('viewer cannot list share links', (select count(*) from public.dms_list_share_links(:'wsa', :doc1)) = 0);
select t.fails('viewer cannot revoke a link',
  format($q$select public.dms_revoke_share_link(%L, (select id from public.document_share_links where token_hash = 'hash-ok'))$q$, :'wsa'), 'forbidden');
select t.as_user(:bob);
select t.fails('bob cannot revoke an A link',
  format($q$select public.dms_revoke_share_link(%L, (select id from public.document_share_links where token_hash = 'hash-ok'))$q$, :'wsa'), 'forbidden');
reset role;
select id as link_ok from public.document_share_links where token_hash = 'hash-ok' \gset
select t.as_user(:judy);
select t.fails('another editor cannot revoke someone else''s link',
  format($q$select public.dms_revoke_share_link(%L, %L)$q$, :'wsa', :'link_ok'), 'forbidden');
select t.as_user(:dave);
select t.fails('revoking an unknown link is not_found',
  format($q$select public.dms_revoke_share_link(%L, gen_random_uuid())$q$, :'wsa'), 'not_found');
select public.dms_revoke_share_link(:'wsa', :'link_ok');
select t.ok('creator can revoke their own link', (select count(*) from public.dms_list_share_links(:'wsa', :doc1)) = 0);
reset role;
select t.ok('revocation is audited', exists (
  select 1 from public.audit_logs where action = 'document.share_revoked' and actor_id = :dave and metadata ->> 'linkId' = :'link_ok'));
set role service_role;
select t.ok('revoked tokens no longer resolve', (select count(*) from public.dms_resolve_share('hash-ok')) = 0);
reset role;
select t.as_user(:dave);
insert into public.document_share_links (workspace_id, document_id, token_hash, expires_at, created_by)
  values (:'wsa', :doc1, 'hash-2', now() + interval '1 hour', :dave);
select t.as_user(:erin);
select public.dms_revoke_share_link(:'wsa', (select id from public.document_share_links where token_hash = 'hash-2'));
reset role;
select t.ok('admin can revoke any link', (select revoked_at is not null from public.document_share_links where token_hash = 'hash-2'));
select t.as_user(:dave);
insert into public.document_share_links (workspace_id, document_id, token_hash, expires_at, created_by)
  values (:'wsa', :doc1, 'hash-3', now() + interval '1 hour', :dave);
reset role;
select set_config('request.jwt.claim.sub', '', false); -- service-role requests carry no user
set role service_role;
select t.ok('live token resolves and returns the link id', (select count(*) from public.dms_resolve_share('hash-3') where link_id is not null) = 1);
reset role;
select t.ok('use of a link is audited without an actor', exists (
  select 1 from public.audit_logs where action = 'document.share_used' and actor_id is null and entity_id = :doc1));
select t.as_user(:erin);
select t.ok('admin sees the share_used entry', (select count(*) from public.audit_logs where action = 'document.share_used') >= 1);
select t.as_user(:dave);
select t.ok('editors cannot read audit logs', (select count(*) from public.audit_logs) = 0);

-- =============================================================== invites
select t.as_user(:carol);
select t.fails('viewer cannot invite', format($q$select public.dms_invite_member(%L, 'x@a.test', 'viewer')$q$, :'wsa'), 'forbidden');
select t.as_user(:dave);
select t.fails('editor cannot invite', format($q$select public.dms_invite_member(%L, 'x@a.test', 'viewer')$q$, :'wsa'), 'forbidden');
select t.as_user(:bob);
select t.fails('outsider cannot invite into A', format($q$select public.dms_invite_member(%L, 'x@a.test', 'viewer')$q$, :'wsa'), 'forbidden');
select t.as_anon();
select t.fails('anon cannot invite', format($q$select public.dms_invite_member(%L, 'x@a.test', 'viewer')$q$, :'wsa'), 'permission denied');

select t.as_user(:erin);
select t.fails('admin cannot invite another admin', format($q$select public.dms_invite_member(%L, 'x@a.test', 'admin')$q$, :'wsa'), 'forbidden');
select t.fails('admin cannot invite an owner', format($q$select public.dms_invite_member(%L, 'x@a.test', 'owner')$q$, :'wsa'), 'forbidden');
select t.fails('invalid role is rejected', format($q$select public.dms_invite_member(%L, 'x@a.test', 'god')$q$, :'wsa'), 'invalid_role');
select t.fails('invalid email is rejected', format($q$select public.dms_invite_member(%L, 'not-an-email', 'viewer')$q$, :'wsa'), 'invalid_email');
select t.fails('inviting an existing member conflicts', format($q$select public.dms_invite_member(%L, 'CAROL@a.test', 'viewer')$q$, :'wsa'), 'conflict');
select public.dms_invite_member(:'wsa', ' Frank@A.test ', 'editor') as inv_frank \gset
select public.dms_invite_member(:'wsa', 'gina@a.test', 'viewer');
select public.dms_invite_member(:'wsa', 'heidi2@x.test', 'viewer');
select t.ok('invite email is normalised', (select email from public.workspace_invites where id = :'inv_frank') = 'frank@a.test');
select public.dms_invite_member(:'wsa', 'frank@a.test', 'viewer');
select t.ok('re-inviting updates the pending invite instead of duplicating',
  (select count(*) from public.workspace_invites where email = 'frank@a.test') = 1
  and (select role from public.workspace_invites where id = :'inv_frank') = 'viewer');
select public.dms_invite_member(:'wsa', 'frank@a.test', 'editor');
select t.ok('admin reads pending invites', (select count(*) from public.workspace_invites where workspace_id = :'wsa') = 3);
reset role;
select t.ok('invites are audited with actor', exists (select 1 from public.audit_logs where action = 'member.invited' and actor_id = :erin and metadata ->> 'email' = 'frank@a.test'));
select t.as_user(:erin);
select t.fails('clients cannot insert invites directly',
  format($q$insert into public.workspace_invites (workspace_id, email, role) values (%L, 'z@a.test', 'owner')$q$, :'wsa'), 'permission denied');
select t.fails('clients cannot insert members directly',
  format($q$insert into public.workspace_members (workspace_id, user_id, role) values (%L, %L, 'owner')$q$, :'wsa', :bob), 'permission denied');
select t.fails('clients cannot change roles directly',
  $q$update public.workspace_members set role = 'owner'$q$, 'permission denied');

select t.as_user(:dave);
select t.ok('editors cannot read invites', (select count(*) from public.workspace_invites) = 0);
select t.as_user(:bob);
select t.ok('outsiders cannot read A invites', (select count(*) from public.workspace_invites) = 0);

select t.as_user(:alice);
select public.dms_invite_member(:'wsa', 'newadmin@a.test', 'admin') as inv_admin \gset
select t.as_user(:erin);
select t.fails('admin cannot revoke an admin invite', format($q$select public.dms_revoke_invite(%L, %L)$q$, :'wsa', :'inv_admin'), 'forbidden');
select t.as_user(:alice);
select public.dms_revoke_invite(:'wsa', :'inv_admin');
select t.ok('owner revokes an invite', not exists (select 1 from public.workspace_invites where id = :'inv_admin'));
select t.fails('revoking twice is not_found', format($q$select public.dms_revoke_invite(%L, %L)$q$, :'wsa', :'inv_admin'), 'not_found');
select t.ok('revocation audited', exists (select 1 from public.audit_logs where action = 'member.invite_revoked'));

-- =============================================================== accepting invites
select t.as_anon();
select t.fails('anon cannot accept invites', $q$select public.dms_accept_invites('x')$q$, 'permission denied');
select t.as_user(:frank);
select t.ok('verified invitee is joined (case-insensitive email match)', public.dms_accept_invites('Frank F') = 1);
select t.ok('membership has the invited role', public.dms_role(:'wsa') = 'editor');
select t.ok('accepting again is a no-op', public.dms_accept_invites('Frank F') = 0);
select t.ok('invitee can now read workspace documents', (select count(*) from public.documents where workspace_id = :'wsa') >= 1);
reset role;
select t.ok('join is audited with the joiner as actor', exists (
  select 1 from public.audit_logs where action = 'member.joined' and actor_id = :frank and metadata ->> 'role' = 'editor'));
select t.as_user(:gina);
select t.ok('unverified email does not accept invites', public.dms_accept_invites('Gina') = 0);
select t.ok('...and gets no access', public.dms_role(:'wsa') is null);
select t.as_user(:heidi);
select t.ok('a different email gets nothing', public.dms_accept_invites('Heidi') = 0);
reset role;
insert into public.workspace_invites (workspace_id, email, role, invited_by, expires_at)
  values (:'wsa', 'heidi@x.test', 'viewer', :alice, now() - interval '1 day');
select t.as_user(:heidi);
select t.ok('expired invites are ignored', public.dms_accept_invites('Heidi') = 0);

-- =============================================================== role changes and removal
select t.as_user(:dave);
select t.fails('editor cannot change roles', format($q$select public.dms_set_member_role(%L, %L, 'viewer')$q$, :'wsa', :carol), 'forbidden');
select t.fails('editor cannot remove members', format($q$select public.dms_remove_member(%L, %L)$q$, :'wsa', :carol), 'forbidden');
select t.as_user(:bob);
select t.fails('outsider cannot change A roles', format($q$select public.dms_set_member_role(%L, %L, 'viewer')$q$, :'wsa', :carol), 'forbidden');
select t.fails('outsider cannot remove A members', format($q$select public.dms_remove_member(%L, %L)$q$, :'wsa', :carol), 'forbidden');

select t.as_user(:erin);
select public.dms_set_member_role(:'wsa', :judy, 'viewer');
select t.ok('admin can demote an editor to viewer', (select role from public.workspace_members where user_id = :judy and workspace_id = :'wsa') = 'viewer');
select t.fails('admin cannot promote to admin', format($q$select public.dms_set_member_role(%L, %L, 'admin')$q$, :'wsa', :carol), 'forbidden');
select t.fails('admin cannot touch an admin', format($q$select public.dms_set_member_role(%L, %L, 'viewer')$q$, :'wsa', :ivan), 'forbidden');
select t.fails('admin cannot touch an owner', format($q$select public.dms_set_member_role(%L, %L, 'viewer')$q$, :'wsa', :alice), 'forbidden');
select t.fails('admin cannot remove an owner', format($q$select public.dms_remove_member(%L, %L)$q$, :'wsa', :alice), 'forbidden');
select t.fails('admin cannot remove an admin', format($q$select public.dms_remove_member(%L, %L)$q$, :'wsa', :ivan), 'forbidden');
select t.fails('nobody changes their own role', format($q$select public.dms_set_member_role(%L, %L, 'owner')$q$, :'wsa', :erin), 'forbidden');
select t.fails('nobody removes themselves', format($q$select public.dms_remove_member(%L, %L)$q$, :'wsa', :erin), 'forbidden');
select t.fails('invalid role is rejected', format($q$select public.dms_set_member_role(%L, %L, 'root')$q$, :'wsa', :carol), 'invalid_role');
select t.fails('unknown member is not_found', format($q$select public.dms_set_member_role(%L, gen_random_uuid(), 'viewer')$q$, :'wsa'), 'not_found');
select public.dms_remove_member(:'wsa', :carol);
select t.ok('admin removes a viewer', not exists (select 1 from public.workspace_members where user_id = :carol and workspace_id = :'wsa'));
select t.as_user(:carol);
select t.ok('removed members lose all access', (select count(*) from public.documents) = 0 and (select count(*) from storage.objects) = 0);

select t.as_user(:alice);
select public.dms_remove_member(:'wsa', :ivan);
select t.ok('owner removes an admin', not exists (select 1 from public.workspace_members where user_id = :ivan));
select t.fails('the sole owner cannot demote themselves', format($q$select public.dms_set_member_role(%L, %L, 'admin')$q$, :'wsa', :alice), 'forbidden');
select t.fails('the sole owner cannot remove themselves', format($q$select public.dms_remove_member(%L, %L)$q$, :'wsa', :alice), 'forbidden');
select public.dms_set_member_role(:'wsa', :erin, 'owner');
select t.ok('owner can promote a second owner', (select count(*) from public.workspace_members where workspace_id = :'wsa' and role = 'owner') = 2);
select t.as_user(:erin);
select public.dms_set_member_role(:'wsa', :alice, 'admin');
select t.ok('a co-owner can demote the other owner', public.dms_role(:'wsa') = 'owner' and (select role from public.workspace_members where user_id = :alice) = 'admin');
select t.as_user(:alice);
select t.fails('the demoted owner cannot touch the remaining owner', format($q$select public.dms_remove_member(%L, %L)$q$, :'wsa', :erin), 'forbidden');
select t.ok('workspace always keeps an owner', (select count(*) from public.workspace_members where workspace_id = :'wsa' and role = 'owner') = 1);
select t.as_user(:erin);
select t.ok('role changes and removals are audited', (select count(distinct action) from public.audit_logs
  where action in ('member.role_changed', 'member.removed', 'member.joined', 'member.invited')) = 4);

-- =============================================================== stale upload cleanup
select t.as_user(:erin);
select public.dms_begin_upload(:'wsa', null, '10000000-0000-4000-8000-0000000000c1', 'stale.pdf', 'stale.pdf', null, 'other', 'application/pdf', 10, 'stale1', 'pdf', 'Erin');
select public.dms_begin_upload(:'wsa', null, '10000000-0000-4000-8000-0000000000c2', 'fresh.pdf', 'fresh.pdf', null, 'other', 'application/pdf', 10, 'fresh1', 'pdf', 'Erin');
select public.dms_begin_upload(:'wsa', '10000000-0000-4000-8000-000000000001', null, 'invoice-1.pdf', 'invoice-1.pdf', null, 'invoice', 'application/pdf', 20, 'stalev2', 'pdf', 'Erin');
reset role;
update public.document_versions set created_at = now() - interval '2 days'
  where document_id = '10000000-0000-4000-8000-0000000000c1' or (document_id = :doc1 and status = 'pending');
select set_config('dms.rpc', '1', false); -- bypass the protected-column guard for fixture backdating
update public.documents set created_at = now() - interval '2 days' where id = '10000000-0000-4000-8000-0000000000c1';
select set_config('dms.rpc', '', false);
select t.as_user(:erin);
select t.fails('clients cannot run cleanup', $q$select public.dms_cleanup_stale_uploads()$q$, 'permission denied');
reset role;
select set_config('request.jwt.claim.sub', '', false);
set role service_role;
select t.fails('cleanup refuses windows shorter than the signed-URL lifetime', $q$select public.dms_cleanup_stale_uploads(interval '1 hour')$q$, 'invalid_interval');
select public.dms_cleanup_stale_uploads(interval '24 hours') as cleaned \gset
reset role;
select t.ok('cleanup returns the abandoned keys', :'cleaned'::text[] @> array[:'wsa' || '/10000000-0000-4000-8000-0000000000c1/v1-stale1.pdf'] and cardinality(:'cleaned'::text[]) = 2);
select t.ok('stale pending document is removed', not exists (select 1 from public.documents where id = '10000000-0000-4000-8000-0000000000c1'));
select t.ok('fresh pending upload is kept', exists (select 1 from public.documents where id = '10000000-0000-4000-8000-0000000000c2'));
select t.ok('stale pending version of a ready document is removed but the document stays',
  exists (select 1 from public.documents where id = :doc1 and status = 'ready')
  and not exists (select 1 from public.document_versions where document_id = :doc1 and status = 'pending'));
select t.ok('cleanup is audited', exists (select 1 from public.audit_logs where action = 'document.upload_expired' and actor_id is null));
select t.ok('cleanup frees the reserved quota', (public.dms_usage(:'wsa') ->> 'usedBytes')::bigint < 1010 + 10 + 1);
