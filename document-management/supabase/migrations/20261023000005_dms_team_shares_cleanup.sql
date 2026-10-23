-- Team management (invites, roles), share-link revocation/audit, and cleanup
-- of abandoned uploads. All writes go through SECURITY DEFINER RPCs that check
-- the caller's role explicitly; clients get read-only table access.

create or replace function public.dms_rank(r text)
returns integer language sql immutable set search_path = '' as $$
  select case r when 'viewer' then 0 when 'editor' then 1 when 'admin' then 2 when 'owner' then 3 end
$$;

-- Invites ------------------------------------------------------------------
create table public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) between 3 and 254),
  role text not null check (role in ('viewer', 'editor', 'admin', 'owner')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz
);
create unique index workspace_invites_pending_idx
  on public.workspace_invites (workspace_id, email) where accepted_at is null;

alter table public.workspace_invites enable row level security;
revoke all on public.workspace_invites from anon, authenticated;
grant select on public.workspace_invites to authenticated;
grant all on public.workspace_invites to service_role;
create policy invites_select on public.workspace_invites for select to authenticated
  using (public.dms_has_role(workspace_id, 'admin'));

-- Membership changes are RPC-only (workspace_members already has no write grants).
create or replace function public.dms_invite_member(p_workspace uuid, p_email text, p_role text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor text := public.dms_role(p_workspace); em text := lower(trim(coalesce(p_email, ''))); inv uuid;
begin
  if (select auth.uid()) is null or actor is null or public.dms_rank(actor) < 2 then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if em !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or char_length(em) > 254 then
    raise exception 'invalid_email' using errcode = '22023';
  end if;
  if p_role is null or public.dms_rank(p_role) is null then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  if public.dms_rank(p_role) >= 2 and actor <> 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace and lower(m.email) = em) then
    raise exception 'conflict' using errcode = '23505';
  end if;
  insert into public.workspace_invites (workspace_id, email, role, invited_by)
  values (p_workspace, em, p_role, (select auth.uid()))
  on conflict (workspace_id, email) where accepted_at is null
  do update set role = excluded.role, invited_by = excluded.invited_by,
                created_at = now(), expires_at = now() + interval '14 days'
  returning id into inv;
  perform public.dms_audit_write(p_workspace, 'member.invited', 'workspace', inv,
    jsonb_build_object('email', em, 'role', p_role));
  return inv;
end $$;

create or replace function public.dms_revoke_invite(p_workspace uuid, p_invite uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare actor text := public.dms_role(p_workspace); inv public.workspace_invites;
begin
  if (select auth.uid()) is null or actor is null or public.dms_rank(actor) < 2 then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into inv from public.workspace_invites i
    where i.id = p_invite and i.workspace_id = p_workspace and i.accepted_at is null for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if public.dms_rank(inv.role) >= 2 and actor <> 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.workspace_invites where id = inv.id;
  perform public.dms_audit_write(p_workspace, 'member.invite_revoked', 'workspace', inv.id,
    jsonb_build_object('email', inv.email, 'role', inv.role));
end $$;

create or replace function public.dms_set_member_role(p_workspace uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
declare actor text := public.dms_role(p_workspace); cur public.workspace_members;
begin
  if (select auth.uid()) is null or actor is null or public.dms_rank(actor) < 2 then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_role is null or public.dms_rank(p_role) is null then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  if p_user = (select auth.uid()) then
    raise exception 'forbidden' using errcode = '42501'; -- no self role changes
  end if;
  -- Serialise owner changes so two concurrent demotions cannot orphan the workspace.
  perform 1 from public.workspace_members m where m.workspace_id = p_workspace and m.role = 'owner' for update;
  select * into cur from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = p_user for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if actor <> 'owner' and (public.dms_rank(cur.role) >= 2 or public.dms_rank(p_role) >= 2) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if cur.role = 'owner' and p_role <> 'owner'
     and (select count(*) from public.workspace_members m where m.workspace_id = p_workspace and m.role = 'owner') <= 1 then
    raise exception 'last_owner' using errcode = 'P0001';
  end if;
  update public.workspace_members set role = p_role where workspace_id = p_workspace and user_id = p_user;
  perform public.dms_audit_write(p_workspace, 'member.role_changed', 'workspace', p_user,
    jsonb_build_object('email', cur.email, 'from', cur.role, 'to', p_role));
end $$;

create or replace function public.dms_remove_member(p_workspace uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare actor text := public.dms_role(p_workspace); cur public.workspace_members;
begin
  if (select auth.uid()) is null or actor is null or public.dms_rank(actor) < 2 then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_user = (select auth.uid()) then
    raise exception 'forbidden' using errcode = '42501'; -- cannot remove yourself
  end if;
  perform 1 from public.workspace_members m where m.workspace_id = p_workspace and m.role = 'owner' for update;
  select * into cur from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = p_user for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if actor <> 'owner' and public.dms_rank(cur.role) >= 2 then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if cur.role = 'owner'
     and (select count(*) from public.workspace_members m where m.workspace_id = p_workspace and m.role = 'owner') <= 1 then
    raise exception 'last_owner' using errcode = 'P0001';
  end if;
  delete from public.workspace_members where workspace_id = p_workspace and user_id = p_user;
  perform public.dms_audit_write(p_workspace, 'member.removed', 'workspace', p_user,
    jsonb_build_object('email', cur.email, 'role', cur.role));
end $$;

-- Joins the caller to every workspace that invited their *verified* email.
-- Unconfirmed addresses never match, so nobody can claim an invite by typing
-- someone else's address at signup.
create or replace function public.dms_accept_invites(p_display_name text default '')
returns integer language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); em text; confirmed timestamptz; r public.workspace_invites; n integer := 0;
begin
  if uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select u.email, u.email_confirmed_at into em, confirmed from auth.users u where u.id = uid;
  if em is null or confirmed is null then return 0; end if;
  for r in
    select * from public.workspace_invites i
    where i.email = lower(em) and i.accepted_at is null and i.expires_at > now() for update
  loop
    insert into public.workspace_members (workspace_id, user_id, role, display_name, email)
    values (r.workspace_id, uid, r.role, left(trim(coalesce(p_display_name, '')), 80), em)
    on conflict (workspace_id, user_id) do nothing;
    update public.workspace_invites set accepted_at = now() where id = r.id;
    perform public.dms_audit_write(r.workspace_id, 'member.joined', 'workspace', uid,
      jsonb_build_object('email', em, 'role', r.role));
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.dms_rank(text), public.dms_invite_member(uuid, text, text),
  public.dms_revoke_invite(uuid, uuid), public.dms_set_member_role(uuid, uuid, text),
  public.dms_remove_member(uuid, uuid), public.dms_accept_invites(text) from public, anon;
grant execute on function public.dms_rank(text), public.dms_invite_member(uuid, text, text),
  public.dms_revoke_invite(uuid, uuid), public.dms_set_member_role(uuid, uuid, text),
  public.dms_remove_member(uuid, uuid), public.dms_accept_invites(text) to authenticated;

-- Share links ---------------------------------------------------------------
-- Clients can no longer edit a link row (expiry, hash, revocation); they use the RPC below.
drop policy share_update on public.document_share_links;
revoke update on public.document_share_links from authenticated;

create or replace function public.dms_list_share_links(p_workspace uuid, p_document uuid)
returns table (id uuid, created_at timestamptz, expires_at timestamptz, created_by uuid, created_by_name text)
language sql stable set search_path = '' as $$
  select l.id, l.created_at, l.expires_at, l.created_by, coalesce(m.display_name, '')
  from public.document_share_links l
  left join public.workspace_members m on m.workspace_id = l.workspace_id and m.user_id = l.created_by
  where l.workspace_id = p_workspace and l.document_id = p_document
    and l.revoked_at is null and l.expires_at > now()
  order by l.created_at desc
$$;

create or replace function public.dms_revoke_share_link(p_workspace uuid, p_link uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); l public.document_share_links;
begin
  if uid is null or not public.dms_has_role(p_workspace, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into l from public.document_share_links s
    where s.id = p_link and s.workspace_id = p_workspace and s.revoked_at is null for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if l.created_by is distinct from uid and not public.dms_has_role(p_workspace, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.document_share_links set revoked_at = now() where id = l.id;
  perform public.dms_audit_write(p_workspace, 'document.share_revoked', 'document', l.document_id,
    jsonb_build_object('linkId', l.id));
end $$;

revoke all on function public.dms_list_share_links(uuid, uuid), public.dms_revoke_share_link(uuid, uuid) from public, anon;
grant execute on function public.dms_list_share_links(uuid, uuid), public.dms_revoke_share_link(uuid, uuid) to authenticated;

-- Resolving a link now also records that it was used (actor is null: link holders are anonymous).
drop function public.dms_resolve_share(text);
create function public.dms_resolve_share(p_token_hash text)
returns table (storage_key text, display_name text, mime_type text, workspace_id uuid, document_id uuid, link_id uuid)
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  select v.storage_key as k, d.display_name as n, v.mime_type as m, d.workspace_id as w, d.id as d_id, l.id as l_id
    into r
  from public.document_share_links l
  join public.documents d on d.id = l.document_id and d.workspace_id = l.workspace_id
  join public.document_versions v on v.document_id = d.id and v.version_number = d.current_version
  where l.token_hash = p_token_hash and l.revoked_at is null and l.expires_at > now()
    and d.status = 'ready' and d.deleted_at is null and v.status = 'ready';
  if not found then return; end if;
  perform public.dms_audit_write(r.w, 'document.share_used', 'document', r.d_id,
    jsonb_build_object('linkId', r.l_id));
  return query select r.k, r.n, r.m, r.w, r.d_id, r.l_id;
end $$;
revoke all on function public.dms_resolve_share(text) from public, anon, authenticated;
grant execute on function public.dms_resolve_share(text) to service_role;

-- Abandoned uploads ---------------------------------------------------------
-- Removes pending versions (and pending documents left without any version)
-- older than the threshold and returns their storage keys so the caller can
-- delete the objects. Signed upload URLs live 2 hours, so the minimum is 3.
create or replace function public.dms_cleanup_stale_uploads(p_older_than interval default interval '24 hours')
returns text[] language plpgsql security definer set search_path = '' as $$
declare keys text[]; n integer;
begin
  if p_older_than < interval '3 hours' then
    raise exception 'invalid_interval' using errcode = '22023';
  end if;
  perform set_config('dms.rpc', '1', true);
  with gone as (
    delete from public.document_versions v
    where v.status = 'pending' and v.created_at < now() - p_older_than
    returning v.storage_key)
  select coalesce(array_agg(storage_key), '{}') into keys from gone;

  with gone as (
    delete from public.documents d
    where d.status = 'pending' and d.created_at < now() - p_older_than
      and not exists (select 1 from public.document_versions v where v.document_id = d.id)
    returning d.id, d.workspace_id, d.display_name)
  select count(*) into n from (
    select public.dms_audit_write(g.workspace_id, 'document.upload_expired', 'document', g.id,
      jsonb_build_object('name', g.display_name)) from gone g) s;
  return keys;
end $$;
revoke all on function public.dms_cleanup_stale_uploads(interval) from public, anon, authenticated;
grant execute on function public.dms_cleanup_stale_uploads(interval) to service_role;
