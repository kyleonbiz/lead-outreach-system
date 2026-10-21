-- 0008_approval_rules.sql
-- Auto-approval rules ("pre-authorizations") must be narrow. This is enforced in three places:
--   1. here, as a CHECK constraint, so no writer (client, service role, SQL editor) can store a broad rule;
--   2. set_approval_policy(), the only way a client may change the policy: admin-only and audited;
--   3. parsePolicy() in the edge functions, which falls back to "approve nothing" on anything invalid.
-- The rules mirror supabase/functions/_shared/core/policy.ts (a unit test keeps the lists identical).

create or replace function private.approval_policy_error(p jsonb)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_label text := '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
  v_domain_re text;
  v_email_re text;
  v_broad text[] := array[
    'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com',
    'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
    'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com', 'yandex.com',
    'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net',
    'qq.com', 'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au',
    'net.au', 'org.au', 'co.nz', 'co.za', 'co.in', 'com.br',
    'co.jp'
  ];
  v_rule jsonb;
  v_action text;
  v_key text;
  v_list jsonb;
  v_max int;
  v_entry text;
  v_dom text;
  v_kind text;
  v_seen text[] := '{}';
begin
  v_domain_re := '^' || v_label || '(\.' || v_label || ')+$';
  v_email_re  := '^[a-z0-9._%+-]{1,64}@' || v_label || '(\.' || v_label || ')+$';

  if p is null or jsonb_typeof(p) <> 'object' then return 'policy must be an object'; end if;
  if exists (select 1 from jsonb_object_keys(p) k where k <> 'auto_approve') then return 'unknown policy field'; end if;
  if jsonb_typeof(p -> 'auto_approve') is distinct from 'array' then return 'auto_approve must be a list'; end if;
  if jsonb_array_length(p -> 'auto_approve') > 50 then return 'too many rules'; end if;

  for v_rule in select * from jsonb_array_elements(p -> 'auto_approve') loop
    if jsonb_typeof(v_rule) <> 'object' then return 'each rule must be an object'; end if;
    v_action := v_rule ->> 'action';
    if v_action = 'email.send' then
      v_key := 'allowed_recipients'; v_max := 50; v_kind := 'recipient';
    elsif v_action = 'calendar.create_event' then
      v_key := 'internal_domains'; v_max := 20; v_kind := 'domain';
    else
      return format('action %L cannot be pre-authorized', v_action);
    end if;
    if v_action = any (v_seen) then return format('only one rule per action is allowed (%s)', v_action); end if;
    v_seen := v_seen || v_action;
    if exists (select 1 from jsonb_object_keys(v_rule) k where k not in ('action', v_key)) then
      return format('unknown field in %s rule', v_action);
    end if;
    v_list := v_rule -> v_key;
    if jsonb_typeof(v_list) is distinct from 'array' then return format('%s must be a list', v_key); end if;
    if jsonb_array_length(v_list) not between 1 and v_max then return format('%s must have 1-%s entries', v_key, v_max); end if;

    for v_entry in select jsonb_array_elements(v_list)::text loop
      -- jsonb_array_elements(...)::text keeps the JSON quotes; reject non-strings before trimming them
      if left(v_entry, 1) <> '"' then return format('%s entries must be text', v_key); end if;
      v_entry := lower(btrim((v_entry::jsonb) #>> '{}'));
      if v_entry = '' or char_length(v_entry) > 200 then return format('invalid entry in %s', v_key); end if;
      if v_kind = 'recipient' and left(v_entry, 1) <> '@' then
        if v_entry !~ v_email_re then return format('%L is not a valid email address', v_entry); end if;
      else
        v_dom := case when left(v_entry, 1) = '@' then substr(v_entry, 2) else v_entry end;
        if v_dom !~ v_domain_re then return format('%L is not a valid domain', v_entry); end if;
        if v_dom = any (v_broad) then return format('%L would allow everyone; list exact addresses instead', v_entry); end if;
      end if;
    end loop;
  end loop;
  return null;
end;
$$;

alter table public.organization_settings
  add constraint approval_policy_is_narrow check (private.approval_policy_error(approval_policy) is null);

-- Clients no longer write the column directly; they call set_approval_policy().
revoke update (approval_policy) on public.organization_settings from authenticated;

create or replace function public.set_approval_policy(p_org uuid, p_policy jsonb)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_err text;
  v_old jsonb;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not private.has_org_role(p_org, array['owner', 'admin']) then
    raise exception 'Only owners and admins can change approval rules' using errcode = '42501';
  end if;
  v_err := private.approval_policy_error(p_policy);
  if v_err is not null then
    raise exception 'Invalid approval rules: %', v_err using errcode = '22023';
  end if;

  select approval_policy into v_old from public.organization_settings where org_id = p_org for update;
  if not found then
    raise exception 'Organization settings not found' using errcode = 'P0002';
  end if;

  update public.organization_settings set approval_policy = p_policy where org_id = p_org;

  insert into public.action_logs (org_id, user_id, actor_type, category, action, status, summary, input, output)
  values (
    p_org, v_uid, 'user', 'audit', 'approval_policy.updated', 'success',
    format('Automatic approval rules changed (%s → %s rules)',
           jsonb_array_length(v_old -> 'auto_approve'), jsonb_array_length(p_policy -> 'auto_approve')),
    jsonb_build_object('before', v_old), jsonb_build_object('after', p_policy)
  );
  return p_policy;
end;
$$;

revoke all on function public.set_approval_policy(uuid, jsonb) from public, anon;
grant execute on function public.set_approval_policy(uuid, jsonb) to authenticated;
