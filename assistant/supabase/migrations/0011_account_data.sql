-- 0011_account_data.sql
-- Ownership transfer and the database half of account deletion.
--
--   * transfer_ownership(): an owner hands ownership to another member, optionally stepping down, atomically and audited.
--     An organization can never be left without an owner (the existing last-owner guard still applies underneath).
--   * account_deletion_plan(): what deleting a user's account would do to each organization they belong to.
--       leave      -> they are not the only owner: they simply leave (the organization and its data stay)
--       delete_org -> they are the only member: the organization and all of its data would be deleted with them
--       blocked    -> they are the only owner of an organization that has other members: ownership must be transferred first
--   * scrub_user_log_text(): removes the user's e-mail address from the free text of the audit entries they created
--     (the entries stay, as an audit trail, but no longer name them).

create or replace function public.transfer_ownership(p_org uuid, p_new_owner uuid, p_step_down boolean default false)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_new_name text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  -- not-an-owner and no-such-organization look the same
  if not private.has_org_role(p_org, array['owner']) then
    raise exception 'Only an owner can transfer ownership' using errcode = '42501';
  end if;
  if p_new_owner = v_uid then
    raise exception 'Choose someone other than yourself' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organization_members where org_id = p_org and user_id = p_new_owner) then
    raise exception 'That person is not a member of this organization' using errcode = '22023';
  end if;

  update public.organization_members set role = 'owner' where org_id = p_org and user_id = p_new_owner;
  if p_step_down then
    update public.organization_members set role = 'admin' where org_id = p_org and user_id = v_uid;
  end if;

  select coalesce(nullif(btrim(p.full_name), ''), 'a team member') into v_new_name from public.profiles p where p.id = p_new_owner;
  insert into public.action_logs (org_id, user_id, actor_type, category, action, status, summary)
  values (p_org, v_uid, 'user', 'audit', 'ownership.transferred', 'success',
          format('Ownership shared with %s%s', coalesce(v_new_name, 'a team member'), case when p_step_down then ' (previous owner stepped down to admin)' else '' end));
end;
$$;

create or replace function public.account_deletion_plan(p_user uuid)
returns table (org_id uuid, org_name text, role text, member_count bigint, owner_count bigint, plan text)
language sql stable security definer
set search_path = ''
as $$
  select m.org_id, o.name, m.role,
         (select count(*) from public.organization_members x where x.org_id = m.org_id),
         (select count(*) from public.organization_members x where x.org_id = m.org_id and x.role = 'owner'),
         case
           when (select count(*) from public.organization_members x where x.org_id = m.org_id) = 1 then 'delete_org'
           when m.role = 'owner' and (select count(*) from public.organization_members x where x.org_id = m.org_id and x.role = 'owner') = 1 then 'blocked'
           else 'leave'
         end
  from public.organization_members m
  join public.organizations o on o.id = m.org_id
  where m.user_id = p_user
  order by o.name;
$$;

create or replace function public.scrub_user_log_text(p_user uuid, p_email text)
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  n int;
  -- the address as a regular expression: every metacharacter escaped, matched case-insensitively
  v_pattern text;
begin
  if p_email is null or char_length(btrim(p_email)) < 3 then return 0; end if;
  v_pattern := regexp_replace(btrim(p_email), '([.+*?^$(){}|\[\]\\])', '\\\1', 'g');
  update public.action_logs
     set summary = regexp_replace(summary, v_pattern, '[deleted account]', 'gi'),
         error   = regexp_replace(error,   v_pattern, '[deleted account]', 'gi')
   where user_id = p_user and (summary ~* v_pattern or error ~* v_pattern);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.transfer_ownership(uuid, uuid, boolean) from public, anon;
grant execute on function public.transfer_ownership(uuid, uuid, boolean) to authenticated;
revoke all on function public.account_deletion_plan(uuid), public.scrub_user_log_text(uuid, text) from public, anon, authenticated;
grant execute on function public.account_deletion_plan(uuid), public.scrub_user_log_text(uuid, text) to service_role;
