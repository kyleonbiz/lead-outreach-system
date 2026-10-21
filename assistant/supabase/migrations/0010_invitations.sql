-- 0010_invitations.sql
-- Team invitations.
--
--   * Only OWNERS invite. An invitation can grant 'admin' or 'member', never 'owner'.
--   * The invitation token is a 256-bit random value that exists in plaintext only in the e-mailed link. The database stores
--     its SHA-256 only (the hash is not shown to any client either).
--   * Accepting needs a signed-in user whose CONFIRMED e-mail equals the invited address, so a leaked link is useless to anyone else.
--   * Single use (row lock + accepted_at), expiring (<= 30 days, default 7), revocable, and one pending invitation per address.
--   * Every step is written to the audit log.

create table public.organization_invitations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  email        text not null check (
                 email = lower(btrim(email)) and char_length(email) between 3 and 254
                 and email ~ '^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$'),
  role         text not null check (role in ('admin', 'member')),
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users (id) on delete set null,
  revoked_at   timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  check (not (accepted_at is not null and revoked_at is not null))
);
-- at most one live invitation per address per organization
create unique index organization_invitations_pending_idx on public.organization_invitations (org_id, email)
  where accepted_at is null and revoked_at is null;
create index organization_invitations_org_idx on public.organization_invitations (org_id, created_at desc);

alter table public.organization_invitations enable row level security;

-- owners see their organization's invitations; nobody writes directly (all writes go through the functions below)
create policy invitations_select on public.organization_invitations for select to authenticated
  using (private.has_org_role(org_id, array['owner']));
grant select (id, org_id, email, role, invited_by, created_at, expires_at, accepted_at, revoked_at)
  on public.organization_invitations to authenticated;   -- token_hash is deliberately not readable

-- ---------------------------------------------------------------------------
-- Create (service role only: the edge function generates the token, stores only its hash, and e-mails the link)
-- ---------------------------------------------------------------------------
create or replace function public.create_invitation(
  p_actor uuid, p_org uuid, p_email text, p_role text, p_token_hash text, p_days int default 7
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
begin
  -- defence in depth: the edge function already checked this with the caller's own token
  if not exists (select 1 from public.organization_members where org_id = p_org and user_id = p_actor and role = 'owner') then
    raise exception 'Only owners can invite people' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('admin', 'member') then
    raise exception 'Invitations can only grant the admin or member role' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.organization_members m join auth.users u on u.id = m.user_id
    where m.org_id = p_org and lower(u.email) = v_email
  ) then
    raise exception 'That person is already a member' using errcode = '23505';
  end if;
  if (select count(*) from public.organization_invitations
       where org_id = p_org and accepted_at is null and revoked_at is null and expires_at > now()) >= 50 then
    raise exception 'Too many pending invitations; revoke some first' using errcode = '53400';
  end if;
  if (select count(*) from public.organization_invitations where org_id = p_org and created_at > now() - interval '24 hours') >= 100 then
    raise exception 'Daily invitation limit reached; try again tomorrow' using errcode = '53400';
  end if;

  -- inviting the same address again replaces (revokes) the earlier link
  update public.organization_invitations set revoked_at = now()
   where org_id = p_org and email = v_email and accepted_at is null and revoked_at is null;

  insert into public.organization_invitations (org_id, email, role, token_hash, invited_by, expires_at)
  values (p_org, v_email, p_role, p_token_hash, p_actor, now() + make_interval(days => greatest(1, least(coalesce(p_days, 7), 30))))
  returning id into v_id;

  insert into public.action_logs (org_id, user_id, actor_type, category, action, status, summary)
  values (p_org, p_actor, 'user', 'audit', 'invitation.created', 'success', format('Invited %s as %s', v_email, p_role));
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Accept (the signed-in invitee)
-- ---------------------------------------------------------------------------
create or replace function public.accept_invitation(p_token text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text;
  v_inv public.organization_invitations;
begin
  if v_uid is null then
    raise exception 'Sign in to accept the invitation' using errcode = '28000';
  end if;
  if p_token is null or char_length(p_token) not between 20 and 200 then
    raise exception 'This invitation is invalid, has expired, or was already used' using errcode = 'P0002';
  end if;

  select lower(btrim(email)) into v_email from auth.users where id = v_uid and email_confirmed_at is not null;
  if v_email is null then
    raise exception 'Confirm your e-mail address first, then open the invitation link again' using errcode = '42501';
  end if;

  -- the row lock makes concurrent attempts take turns: the second one sees accepted_at and fails
  select * into v_inv from public.organization_invitations where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') for update;
  if not found or v_inv.accepted_at is not null or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
    raise exception 'This invitation is invalid, has expired, or was already used' using errcode = 'P0002';
  end if;
  if v_inv.email <> v_email then
    raise exception 'This invitation was sent to a different e-mail address. Sign in with the address it was sent to.' using errcode = '42501';
  end if;
  if exists (select 1 from public.organization_members where org_id = v_inv.org_id and user_id = v_uid) then
    raise exception 'You are already a member of this organization' using errcode = '23505';
  end if;

  insert into public.organization_members (org_id, user_id, role) values (v_inv.org_id, v_uid, v_inv.role);
  update public.organization_invitations set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
  insert into public.action_logs (org_id, user_id, actor_type, category, action, status, summary)
  values (v_inv.org_id, v_uid, 'user', 'audit', 'invitation.accepted', 'success', format('%s joined as %s', v_email, v_inv.role));
  return jsonb_build_object('org_id', v_inv.org_id, 'role', v_inv.role);
end;
$$;

-- ---------------------------------------------------------------------------
-- Revoke (owners)
-- ---------------------------------------------------------------------------
create or replace function public.revoke_invitation(p_id uuid)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_inv public.organization_invitations;
begin
  select * into v_inv from public.organization_invitations where id = p_id;
  -- not found and not-an-owner look identical, so invitation ids of other organizations cannot be probed
  if not found or not private.has_org_role(v_inv.org_id, array['owner']) then
    raise exception 'Invitation not found' using errcode = 'P0002';
  end if;
  update public.organization_invitations set revoked_at = now() where id = p_id and accepted_at is null and revoked_at is null;
  if not found then return false; end if;
  insert into public.action_logs (org_id, user_id, actor_type, category, action, status, summary)
  values (v_inv.org_id, (select auth.uid()), 'user', 'audit', 'invitation.revoked', 'success', format('Revoked the invitation for %s', v_inv.email));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Member directory: names for everyone in the organization, e-mail addresses for owners and admins only
-- ---------------------------------------------------------------------------
create or replace function public.org_members(p_org uuid)
returns table (user_id uuid, full_name text, email text, role text, joined_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select m.user_id, p.full_name,
         case when private.has_org_role(p_org, array['owner', 'admin']) then u.email::text end,
         m.role, m.created_at
  from public.organization_members m
  left join public.profiles p on p.id = m.user_id
  left join auth.users u on u.id = m.user_id
  where m.org_id = p_org and private.is_org_member(p_org)
  order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.created_at;
$$;

revoke all on function public.create_invitation(uuid, uuid, text, text, text, int) from public, anon, authenticated;
grant execute on function public.create_invitation(uuid, uuid, text, text, text, int) to service_role;
revoke all on function public.accept_invitation(text), public.revoke_invitation(uuid), public.org_members(uuid) from public, anon;
grant execute on function public.accept_invitation(text), public.revoke_invitation(uuid), public.org_members(uuid) to authenticated;
