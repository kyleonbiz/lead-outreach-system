-- 0009_notification_delivery.sql
-- Delivers in-app notifications outside the app: e-mail (to each member's own verified address) and
-- Slack / Microsoft Teams incoming webhooks.
--
-- Design:
--   * Anything that inserts a row into public.notifications is delivered automatically: a trigger fans the row
--     out into notification_deliveries (an outbox). Nothing else needs to know about channels.
--   * A worker (the existing 1-minute workflow-tick) claims due deliveries, sends them and reports back.
--     Claims are leased, retried with back-off and deduplicated, so a crash or a double tick never sends twice.
--   * Webhook URLs are bearer secrets: stored encrypted in notification_channel_secrets, which no client role can read.
--   * E-mail is only ever sent to the member's own confirmed sign-in address, never to an address a client supplies.

alter table public.notifications add constraint notifications_id_org_key unique (id, org_id);

-- ---------------------------------------------------------------------------
-- Per-user preferences (which e-mails I want)
-- ---------------------------------------------------------------------------
create table public.notification_preferences (
  org_id                 uuid not null,
  user_id                uuid not null,
  email_workflow_failed  boolean not null default true,
  email_approval_needed  boolean not null default true,
  email_task_overdue     boolean not null default false,
  updated_at             timestamptz not null default now(),
  primary key (org_id, user_id),
  foreign key (org_id, user_id) references public.organization_members (org_id, user_id) on delete cascade
);
create trigger set_updated_at before update on public.notification_preferences
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Shared channels (Slack / Teams), managed by owners and admins through an edge function
-- ---------------------------------------------------------------------------
create table public.notification_channels (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  kind          text not null check (kind in ('slack', 'teams')),
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  url_hint      text not null check (char_length(url_hint) <= 120),   -- display only, e.g. "hooks.slack.com/…/9xYz"
  events        text[] not null default array['workflow_failed', 'approval_needed']
                check (cardinality(events) between 1 and 4
                       and events <@ array['workflow_failed', 'approval_needed', 'task_overdue', 'workflow_message']),
  enabled       boolean not null default true,
  last_status   text check (last_status in ('ok', 'failed')),
  last_error    text,
  last_sent_at  timestamptz,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, org_id)
);
create index notification_channels_org_idx on public.notification_channels (org_id);
create trigger set_updated_at before update on public.notification_channels
  for each row execute function private.set_updated_at();

-- ciphertext of the webhook URL (AES-256-GCM, bound to the channel id). No policies, no grants: service role only.
create table public.notification_channel_secrets (
  channel_id     uuid primary key references public.notification_channels (id) on delete cascade,
  org_id         uuid not null references public.organizations (id) on delete cascade,
  encrypted_url  text not null,
  key_version    int not null default 1,
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Delivery outbox
-- ---------------------------------------------------------------------------
create table public.notification_deliveries (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  notification_id  uuid not null,
  channel          text not null check (channel in ('email', 'slack', 'teams')),
  user_id          uuid,   -- e-mail recipient
  channel_id       uuid,   -- webhook destination
  dedupe_key       text not null unique,
  status           text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text,
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  foreign key (notification_id, org_id) references public.notifications (id, org_id) on delete cascade,
  foreign key (channel_id, org_id) references public.notification_channels (id, org_id) on delete cascade,
  foreign key (org_id, user_id) references public.organization_members (org_id, user_id) on delete cascade,
  check ((channel = 'email' and user_id is not null and channel_id is null)
      or (channel <> 'email' and channel_id is not null and user_id is null))
);
create index notification_deliveries_due_idx on public.notification_deliveries (next_attempt_at) where status in ('pending', 'sending');
create index notification_deliveries_org_idx on public.notification_deliveries (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Fan-out: notifications -> deliveries
-- ---------------------------------------------------------------------------
create or replace function private.fan_out_notification()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- e-mail: a targeted notification goes to that member; an organization-wide one to owners and admins.
  insert into public.notification_deliveries (org_id, notification_id, channel, user_id, dedupe_key)
  select new.org_id, new.id, 'email', m.user_id, new.id || ':email:' || m.user_id
  from public.organization_members m
  left join public.notification_preferences p on p.org_id = m.org_id and p.user_id = m.user_id
  where m.org_id = new.org_id
    and case when new.user_id is not null then m.user_id = new.user_id else m.role in ('owner', 'admin') end
    and case new.type
          when 'workflow_failed' then coalesce(p.email_workflow_failed, true)
          when 'approval_needed' then coalesce(p.email_approval_needed, true)
          when 'task_overdue'    then coalesce(p.email_task_overdue, false)
          else false
        end
  on conflict (dedupe_key) do nothing;

  -- shared channels only receive organization-wide notifications (never one meant for a single person)
  if new.user_id is null then
    insert into public.notification_deliveries (org_id, notification_id, channel, channel_id, dedupe_key)
    select new.org_id, new.id, c.kind, c.id, new.id || ':' || c.kind || ':' || c.id
    from public.notification_channels c
    where c.org_id = new.org_id and c.enabled and new.type = any (c.events)
    on conflict (dedupe_key) do nothing;
  end if;
  return null;
end;
$$;
create trigger fan_out_notification after insert on public.notifications
  for each row execute function private.fan_out_notification();

-- ---------------------------------------------------------------------------
-- Hook: chat-originated approvals (workflow approvals are already announced by the workflow engine)
-- ---------------------------------------------------------------------------
create or replace function private.notify_approval_requested()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.notifications (org_id, type, title, body, link)
  values (new.org_id, 'approval_needed', 'Approval needed', left(new.summary, 300), '/');
  return null;
end;
$$;
create trigger notify_approval_requested after insert on public.approval_requests
  for each row when (new.status = 'pending' and new.workflow_run_id is null)
  execute function private.notify_approval_requested();

-- ---------------------------------------------------------------------------
-- Hook: overdue tasks (one summary per organization per run; each task is announced once)
-- ---------------------------------------------------------------------------
alter table public.tasks add column overdue_notified_at timestamptz;

-- the bookkeeping column must not show up as a user "update" in task history
create or replace function private.tasks_after_write()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor_type text := coalesce(nullif(current_setting('app.actor_type', true), ''),
                                case when (select auth.uid()) is null then 'system' else 'user' end);
  v_event text;
begin
  if v_actor_type not in ('user', 'assistant', 'workflow', 'system') then
    v_actor_type := 'system';
  end if;

  if tg_op = 'INSERT' then
    v_event := 'created';
  elsif new.status = 'done' and old.status <> 'done' then
    v_event := 'completed';
  elsif old.status = 'done' and new.status <> 'done' then
    v_event := 'reopened';
  elsif new.status <> old.status then
    v_event := 'status_changed';
  elsif (to_jsonb(new) - 'updated_at' - 'overdue_notified_at') is distinct from (to_jsonb(old) - 'updated_at' - 'overdue_notified_at') then
    v_event := 'updated';
  else
    return null;
  end if;

  insert into public.task_history (org_id, task_id, event, actor_user_id, actor_type, data)
  values (
    new.org_id, new.id, v_event, (select auth.uid()), v_actor_type,
    case when tg_op = 'INSERT' then jsonb_build_object('title', new.title)
         else jsonb_build_object('from_status', old.status, 'to_status', new.status) end
  );
  return null;
end;
$$;

-- a changed due date or a reopened task may be announced again
create or replace function private.tasks_reset_overdue()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.due_at is distinct from old.due_at
     or (old.status in ('done', 'cancelled') and new.status not in ('done', 'cancelled')) then
    new.overdue_notified_at := null;
  end if;
  return new;
end;
$$;
create trigger tasks_reset_overdue before update on public.tasks
  for each row execute function private.tasks_reset_overdue();

create or replace function public.notify_overdue_tasks(p_limit int default 200)
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_marked int;
begin
  with picked as (
    select t.id from public.tasks t
    where t.overdue_notified_at is null and t.due_at < now() and t.status in ('todo', 'in_progress', 'blocked')
    order by t.due_at
    limit greatest(1, least(p_limit, 500))
    for update skip locked
  ), marked as (
    update public.tasks t set overdue_notified_at = now()
    from picked where t.id = picked.id
    returning t.org_id, t.title, t.due_at
  ), per_org as (
    select org_id, count(*) as cnt, (array_agg(title order by due_at))[1:5] as titles
    from marked group by org_id
  ), announced as (
    insert into public.notifications (org_id, type, title, body, link)
    select p.org_id, 'task_overdue',
           case when p.cnt = 1 then '1 task is overdue' else p.cnt || ' tasks are overdue' end,
           (select string_agg('• ' || left(x.t, 80), E'\n' order by x.ord) from unnest(p.titles) with ordinality as x(t, ord))
             || case when p.cnt > 5 then E'\n…and ' || (p.cnt - 5) || ' more' else '' end,
           '/tasks'
    from per_org p
    returning 1
  )
  select (select count(*) from marked) into v_marked;
  return v_marked;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker API (service role only)
-- ---------------------------------------------------------------------------
create or replace function public.claim_notification_deliveries(p_limit int default 20)
returns table (
  delivery_id uuid, delivery_org_id uuid, delivery_channel text, delivery_user_id uuid, delivery_channel_id uuid,
  delivery_attempts int, recipient_email text, n_type text, n_title text, n_body text, n_link text, org_name text
)
language plpgsql security definer
set search_path = ''
as $$
begin
  -- a worker that died mid-send leaves a lapsed lease; after the last attempt that delivery is failed, not retried forever
  update public.notification_deliveries d
     set status = 'failed', last_error = left(coalesce(d.last_error || ' · ', '') || 'the sender stopped before finishing (timed out)', 500)
   where d.status = 'sending' and d.next_attempt_at <= now() and d.attempts >= 5;

  return query
  with due as (
    select d.id from public.notification_deliveries d
    where d.status in ('pending', 'sending') and d.next_attempt_at <= now()
    order by d.next_attempt_at
    limit greatest(1, least(p_limit, 100))
    for update skip locked
  ), claimed as (
    update public.notification_deliveries d
       set status = 'sending', attempts = d.attempts + 1, next_attempt_at = now() + interval '5 minutes'  -- lease
      from due where d.id = due.id
    returning d.*
  )
  select c.id, c.org_id, c.channel, c.user_id, c.channel_id, c.attempts,
         au.email::text, n.type, n.title, n.body, n.link, o.name
  from claimed c
  join public.notifications n on n.id = c.notification_id and n.org_id = c.org_id
  join public.organizations o on o.id = c.org_id
  left join auth.users au on au.id = c.user_id and au.email_confirmed_at is not null;
end;
$$;

create or replace function public.complete_notification_delivery(
  p_id uuid, p_outcome text, p_error text default null, p_retry_in_seconds int default 300
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  d public.notification_deliveries;
begin
  if p_outcome not in ('sent', 'failed', 'retry', 'skipped') then
    raise exception 'invalid outcome %', p_outcome using errcode = '22023';
  end if;
  -- only a delivery that is currently leased can be completed (a late/duplicate report changes nothing)
  select * into d from public.notification_deliveries where id = p_id and status = 'sending' for update;
  if not found then return; end if;

  if p_outcome = 'retry' and d.attempts >= 5 then
    p_outcome := 'failed';
    p_error := coalesce(p_error, 'gave up after 5 attempts');
  end if;

  update public.notification_deliveries set
    status = case p_outcome when 'retry' then 'pending' when 'sent' then 'sent' when 'skipped' then 'skipped' else 'failed' end,
    last_error = left(case p_outcome when 'sent' then null else p_error end, 500),
    sent_at = case when p_outcome = 'sent' then now() else sent_at end,
    next_attempt_at = case when p_outcome = 'retry' then now() + make_interval(secs => greatest(30, least(coalesce(p_retry_in_seconds, 300), 21600))) else next_attempt_at end
  where id = p_id;

  if d.channel_id is not null and p_outcome in ('sent', 'failed') then
    update public.notification_channels set
      last_status = case when p_outcome = 'sent' then 'ok' else 'failed' end,
      last_error = left(case when p_outcome = 'sent' then null else p_error end, 300),
      last_sent_at = case when p_outcome = 'sent' then now() else last_sent_at end
    where id = d.channel_id;
  end if;
end;
$$;

create or replace function public.prune_notification_deliveries()
returns int
language plpgsql security definer
set search_path = ''
as $$
declare n int;
begin
  delete from public.notification_deliveries
   where (status in ('sent', 'skipped') and created_at < now() - interval '30 days')
      or (status = 'failed' and created_at < now() - interval '90 days');
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.notify_overdue_tasks(int), public.claim_notification_deliveries(int),
  public.complete_notification_delivery(uuid, text, text, int), public.prune_notification_deliveries() from public, anon, authenticated;
grant execute on function public.notify_overdue_tasks(int), public.claim_notification_deliveries(int),
  public.complete_notification_delivery(uuid, text, text, int), public.prune_notification_deliveries() to service_role;

-- ---------------------------------------------------------------------------
-- RLS and privileges
-- ---------------------------------------------------------------------------
alter table public.notification_preferences    enable row level security;
alter table public.notification_channels       enable row level security;
alter table public.notification_channel_secrets enable row level security;
alter table public.notification_deliveries     enable row level security;

create policy prefs_select on public.notification_preferences for select to authenticated
  using (user_id = (select auth.uid()) and private.is_org_member(org_id));
create policy prefs_insert on public.notification_preferences for insert to authenticated
  with check (user_id = (select auth.uid()) and private.is_org_member(org_id));
create policy prefs_update on public.notification_preferences for update to authenticated
  using (user_id = (select auth.uid()) and private.is_org_member(org_id))
  with check (user_id = (select auth.uid()) and private.is_org_member(org_id));

-- channel configuration is visible to admins only; changes go through the edge function (URL validation + encryption)
create policy channels_select on public.notification_channels for select to authenticated
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- admins see the org's delivery log; everyone sees their own e-mails
create policy deliveries_select on public.notification_deliveries for select to authenticated
  using (private.has_org_role(org_id, array['owner', 'admin'])
         or (channel = 'email' and user_id = (select auth.uid())));

grant select, insert on public.notification_preferences to authenticated;
grant update (email_workflow_failed, email_approval_needed, email_task_overdue) on public.notification_preferences to authenticated;
grant select on public.notification_channels to authenticated;
grant select on public.notification_deliveries to authenticated;
-- notification_channel_secrets: intentionally no grants.
