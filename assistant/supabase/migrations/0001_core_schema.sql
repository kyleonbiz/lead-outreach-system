-- 0001_core_schema.sql
-- Multi-tenant core schema. Every organization-owned row carries org_id and child
-- rows use composite foreign keys (id, org_id) so a row can never reference a parent
-- that belongs to a different organization.

-- helper functions below reference tables created later in this file
set check_function_bodies = off;

create schema if not exists private;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER, not exposed through the API: schema "private")
-- ---------------------------------------------------------------------------
create or replace function private.is_org_member(p_org uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
    where m.org_id = p_org and m.user_id = (select auth.uid())
  );
$$;

create or replace function private.has_org_role(p_org uuid, p_roles text[])
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
    where m.org_id = p_org and m.user_id = (select auth.uid()) and m.role = any (p_roles)
  );
$$;

create or replace function private.shares_org_with(p_user uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members a
    join public.organization_members b on a.org_id = b.org_id
    where a.user_id = (select auth.uid()) and b.user_id = p_user
  );
$$;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Identity & tenancy
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text check (char_length(full_name) <= 200),
  avatar_url  text,
  timezone    text not null default 'UTC',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.organization_members (
  org_id      uuid not null references public.organizations (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id);

create table public.organization_settings (
  org_id            uuid primary key references public.organizations (id) on delete cascade,
  timezone          text not null default 'UTC',
  business_hours    jsonb not null default '{}'::jsonb,
  ai_provider       text not null default 'anthropic' check (ai_provider in ('anthropic')),
  ai_model          text,  -- null = use the server default (ASSISTANT_DEFAULT_MODEL)
  -- Narrow, explicit pre-authorizations. Empty by default: everything sensitive needs approval.
  -- Shape is validated server-side in Phase 3: {"auto_approve": [{"action": "...", "constraints": {...}}]}
  approval_policy   jsonb not null default '{"auto_approve": []}'::jsonb
                    check (jsonb_typeof(approval_policy -> 'auto_approve') = 'array'),
  briefing_enabled  boolean not null default false,
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Integrations. Tokens live ONLY in integration_credentials (service role access only).
-- ---------------------------------------------------------------------------
create table public.connected_integrations (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete cascade,
  connected_by      uuid references auth.users (id) on delete set null,
  provider          text not null check (provider in
                      ('google_gmail', 'google_calendar', 'microsoft_mail', 'microsoft_calendar')),
  status            text not null default 'connected'
                      check (status in ('connected', 'needs_reauth', 'revoked', 'error')),
  external_account  text not null,
  scopes            text[] not null default '{}',
  last_error        text,
  last_synced_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, provider, external_account)
);

create table public.integration_credentials (
  integration_id     uuid primary key references public.connected_integrations (id) on delete cascade,
  org_id             uuid not null references public.organizations (id) on delete cascade,
  encrypted_payload  text not null,   -- ciphertext (AES-256-GCM, app-level); never plaintext
  key_version        int not null default 1,
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Assistant conversations
-- ---------------------------------------------------------------------------
create table public.assistant_conversations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  user_id     uuid not null default auth.uid(),
  title       text check (char_length(title) <= 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, org_id),
  foreign key (org_id, user_id) references public.organization_members (org_id, user_id) on delete cascade
);
create index assistant_conversations_user_idx on public.assistant_conversations (org_id, user_id, updated_at desc);

create table public.assistant_messages (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  conversation_id  uuid not null,
  role             text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content          text not null check (char_length(content) <= 100000),
  tool_calls       jsonb,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  foreign key (conversation_id, org_id) references public.assistant_conversations (id, org_id) on delete cascade
);
create index assistant_messages_conv_idx on public.assistant_messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------
create table public.tasks (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  title         text not null check (char_length(btrim(title)) between 1 and 300),
  description   text check (char_length(description) <= 20000),
  notes         text check (char_length(notes) <= 20000),
  status        text not null default 'todo'
                  check (status in ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
  priority      text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  category      text check (char_length(category) <= 80),
  due_at        timestamptz,
  recurrence    text check (recurrence in ('daily', 'weekdays', 'weekly', 'biweekly', 'monthly')),
  assignee_id   uuid,
  created_by    uuid references auth.users (id) on delete set null default auth.uid(),
  created_via   text not null default 'user' check (created_via in ('user', 'assistant', 'workflow')),
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, org_id),
  foreign key (org_id, assignee_id) references public.organization_members (org_id, user_id)
    on delete set null (assignee_id)
);
create index tasks_org_status_due_idx on public.tasks (org_id, status, due_at);
create index tasks_assignee_idx on public.tasks (org_id, assignee_id) where assignee_id is not null;

create table public.task_history (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null,
  task_id        uuid not null,
  event          text not null check (event in ('created', 'updated', 'status_changed', 'completed', 'reopened')),
  actor_user_id  uuid,
  actor_type     text not null default 'user' check (actor_type in ('user', 'assistant', 'workflow', 'system')),
  data           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  foreign key (task_id, org_id) references public.tasks (id, org_id) on delete cascade
);
create index task_history_task_idx on public.task_history (task_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Calendar references (events themselves stay in the provider)
-- ---------------------------------------------------------------------------
create table public.calendar_event_references (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null,
  integration_id     uuid not null,
  provider_event_id  text not null,
  calendar_id        text not null default 'primary',
  title              text,
  starts_at          timestamptz,
  ends_at            timestamptz,
  attendees          jsonb not null default '[]'::jsonb,
  linked_task_id     uuid,
  last_synced_at     timestamptz not null default now(),
  foreign key (integration_id, org_id) references public.connected_integrations (id, org_id) on delete cascade,
  foreign key (linked_task_id, org_id) references public.tasks (id, org_id) on delete set null (linked_task_id),
  unique (integration_id, calendar_id, provider_event_id)
);
create index calendar_event_refs_time_idx on public.calendar_event_references (org_id, starts_at);

-- ---------------------------------------------------------------------------
-- Documents & knowledge base
-- ---------------------------------------------------------------------------
create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  uploaded_by   uuid references auth.users (id) on delete set null default auth.uid(),
  name          text not null check (char_length(btrim(name)) between 1 and 300),
  storage_path  text not null unique,
  mime_type     text,
  size_bytes    bigint check (size_bytes >= 0),
  category      text check (char_length(category) <= 80),
  summary       text,
  extracted     jsonb not null default '{}'::jsonb,
  status        text not null default 'uploaded' check (status in ('uploaded', 'processing', 'ready', 'failed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, org_id),
  -- files are namespaced by organization: "<org_id>/<file path>"
  check (storage_path like org_id::text || '/%')
);
create index documents_org_idx on public.documents (org_id, created_at desc);

create table public.knowledge_base_sources (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  kind         text not null check (kind in
                 ('company', 'service', 'hours', 'policy', 'faq', 'guideline', 'contact', 'sop', 'document')),
  title        text not null check (char_length(btrim(title)) between 1 and 200),
  content      text not null default '' check (char_length(content) <= 100000),
  document_id  uuid,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (document_id, org_id) references public.documents (id, org_id) on delete cascade
);
create index knowledge_base_org_idx on public.knowledge_base_sources (org_id, kind) where is_active;

-- ---------------------------------------------------------------------------
-- Workflows (definitions are declarative JSON of allow-listed step types; no arbitrary code)
-- ---------------------------------------------------------------------------
create table public.workflows (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  name             text not null check (char_length(btrim(name)) between 1 and 200),
  description      text,
  enabled          boolean not null default false,
  trigger_type     text not null default 'manual' check (trigger_type in ('manual', 'schedule', 'event')),
  trigger_config   jsonb not null default '{}'::jsonb,
  current_version  int not null default 1,
  created_by       uuid references auth.users (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, org_id)
);

create table public.workflow_versions (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  workflow_id  uuid not null,
  version      int not null check (version > 0),
  definition   jsonb not null,
  created_by   uuid references auth.users (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  unique (id, org_id),
  unique (workflow_id, version),
  foreign key (workflow_id, org_id) references public.workflows (id, org_id) on delete cascade
);

create table public.workflow_runs (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  workflow_id      uuid not null,
  version_id       uuid,
  status           text not null default 'queued'
                     check (status in ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
  trigger_source   text not null default 'manual' check (trigger_source in ('manual', 'schedule', 'event')),
  idempotency_key  text,
  attempt          int not null default 1,
  scheduled_for    timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  error            text,
  output           jsonb,
  created_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (workflow_id, org_id) references public.workflows (id, org_id) on delete cascade,
  foreign key (version_id, org_id) references public.workflow_versions (id, org_id) on delete set null (version_id)
);
-- A scheduled/event firing with the same key can only ever create one run.
create unique index workflow_runs_idem_idx on public.workflow_runs (workflow_id, idempotency_key)
  where idempotency_key is not null;
create index workflow_runs_org_idx on public.workflow_runs (org_id, created_at desc);

create table public.workflow_steps (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  run_id       uuid not null,
  step_key     text not null,
  step_type    text not null,
  status       text not null default 'pending'
                 check (status in ('pending', 'running', 'waiting_approval', 'succeeded', 'failed', 'skipped')),
  attempt      int not null default 0,
  input        jsonb,
  output       jsonb,
  error        text,
  started_at   timestamptz,
  finished_at  timestamptz,
  unique (run_id, step_key),
  foreign key (run_id, org_id) references public.workflow_runs (id, org_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Approvals, activity log, notifications, usage
-- ---------------------------------------------------------------------------
create table public.approval_requests (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete cascade,
  requested_by      uuid references auth.users (id) on delete set null,
  conversation_id   uuid,
  workflow_run_id   uuid,
  action_type       text not null,   -- e.g. 'email.send', 'task.delete'
  summary           text not null,   -- human-readable description of exactly what will happen
  payload           jsonb not null,  -- the exact validated tool input that will be executed
  risk              text not null default 'high' check (risk in ('low', 'medium', 'high')),
  status            text not null default 'pending'
                      check (status in ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
  decided_by        uuid references auth.users (id) on delete set null,
  decided_at        timestamptz,
  decision_note     text,
  expires_at        timestamptz not null default (now() + interval '7 days'),
  executed_at       timestamptz,
  error             text,
  created_at        timestamptz not null default now(),
  unique (id, org_id),
  foreign key (conversation_id, org_id) references public.assistant_conversations (id, org_id) on delete set null (conversation_id),
  foreign key (workflow_run_id, org_id) references public.workflow_runs (id, org_id) on delete set null (workflow_run_id)
);
create index approval_requests_pending_idx on public.approval_requests (org_id, created_at desc) where status = 'pending';

-- Append-only activity + audit log.
create table public.action_logs (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete cascade,
  user_id           uuid references auth.users (id) on delete set null,
  actor_type        text not null check (actor_type in ('user', 'assistant', 'workflow', 'system')),
  category          text not null default 'tool_call' check (category in ('tool_call', 'audit', 'integration', 'error')),
  tool_name         text,
  action            text not null,
  status            text not null check (status in ('success', 'failure', 'pending', 'denied')),
  summary           text,
  input             jsonb,   -- must be redacted server-side before insert (no tokens/secrets)
  output            jsonb,
  error             text,
  conversation_id   uuid,
  approval_id       uuid,
  workflow_run_id   uuid,
  idempotency_key   text,
  duration_ms       int,
  created_at        timestamptz not null default now()
);
create index action_logs_org_idx on public.action_logs (org_id, created_at desc);
-- Duplicate-action protection: a keyed action can be logged/executed once.
create unique index action_logs_idem_idx on public.action_logs (org_id, idempotency_key)
  where idempotency_key is not null;

create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  user_id     uuid references auth.users (id) on delete cascade,  -- null = visible to whole org
  type        text not null,
  title       text not null,
  body        text,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (org_id, user_id, created_at desc);

create table public.usage_records (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  user_id     uuid references auth.users (id) on delete set null,
  kind        text not null check (kind in ('llm_input_tokens', 'llm_output_tokens', 'tool_call', 'workflow_run', 'storage_bytes')),
  quantity    numeric not null check (quantity >= 0),
  model       text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index usage_records_org_idx on public.usage_records (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'organizations', 'organization_settings', 'connected_integrations',
    'assistant_conversations', 'tasks', 'documents', 'knowledge_base_sources', 'workflows'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function private.set_updated_at()', t);
  end loop;
end $$;

-- New auth user -> profile
create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Never let an organization end up without an owner.
create or replace function private.guard_last_owner()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner')
     and not exists (
       select 1 from public.organization_members m
       where m.org_id = old.org_id and m.role = 'owner' and m.user_id <> old.user_id
     )
     -- allow cascade deletion of the whole organization
     and exists (select 1 from public.organizations o where o.id = old.org_id)
  then
    raise exception 'An organization must keep at least one owner' using errcode = '23514';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger guard_last_owner before update or delete on public.organization_members
  for each row execute function private.guard_last_owner();

-- Task bookkeeping: completed_at + history. The actor type can be set per transaction by
-- trusted server code: select set_config('app.actor_type', 'assistant', true);
create or replace function private.tasks_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'done' then
    if tg_op = 'INSERT' or old.status is distinct from 'done' then
      new.completed_at = now();
    end if;
  else
    new.completed_at = null;
  end if;
  return new;
end;
$$;
create trigger tasks_before_write before insert or update on public.tasks
  for each row execute function private.tasks_before_write();

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
  elsif (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
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
create trigger tasks_after_write after insert or update on public.tasks
  for each row execute function private.tasks_after_write();

-- Approval decisions: only status/decision fields may change, only from 'pending', and the
-- decider is stamped from the session (cannot be spoofed). Execution state is service-role only.
create or replace function private.guard_approval_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- service-role requests carry no end-user identity; real users always have auth.uid()
  v_is_service boolean := (select auth.uid()) is null;
begin
  if v_is_service then
    return new;
  end if;

  if old.status <> 'pending' then
    raise exception 'Approval request was already decided' using errcode = '23514';
  end if;
  if new.status not in ('approved', 'rejected') then
    raise exception 'Users may only approve or reject' using errcode = '23514';
  end if;
  if old.expires_at < now() then
    raise exception 'Approval request has expired' using errcode = '23514';
  end if;
  if (to_jsonb(new) - 'status' - 'decision_note' - 'decided_by' - 'decided_at')
     is distinct from
     (to_jsonb(old) - 'status' - 'decision_note' - 'decided_by' - 'decided_at') then
    raise exception 'Only the decision may be changed' using errcode = '23514';
  end if;
  new.decided_by = (select auth.uid());
  new.decided_at = now();
  return new;
end;
$$;
create trigger guard_approval_update before update on public.approval_requests
  for each row execute function private.guard_approval_update();

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------
-- Creating an org must bootstrap membership, which RLS (rightly) forbids for clients.
create or replace function public.create_organization(p_name text, p_timezone text default 'UTC')
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 120 then
    raise exception 'Organization name must be 1-120 characters' using errcode = '22023';
  end if;
  if (select count(*) from public.organization_members where user_id = v_uid and role = 'owner') >= 5 then
    raise exception 'Organization limit reached' using errcode = '53400';
  end if;

  insert into public.organizations (name, created_by) values (btrim(p_name), v_uid) returning id into v_org;
  insert into public.organization_members (org_id, user_id, role) values (v_org, v_uid, 'owner');
  insert into public.organization_settings (org_id, timezone) values (v_org, coalesce(nullif(p_timezone, ''), 'UTC'));
  insert into public.action_logs (org_id, user_id, actor_type, category, action, status, summary)
  values (v_org, v_uid, 'user', 'audit', 'organization.created', 'success', 'Organization created');
  return v_org;
end;
$$;

-- Complete a task; if it recurs, create the next occurrence. SECURITY INVOKER: RLS applies,
-- so the assistant (acting with the user's JWT) and the UI share exactly the same rules.
create or replace function public.complete_task(p_task_id uuid)
returns uuid
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_task public.tasks;
  v_base timestamptz;
  v_next timestamptz;
  v_new uuid;
begin
  update public.tasks set status = 'done'
  where id = p_task_id and status not in ('done', 'cancelled')
  returning * into v_task;

  if not found then
    return null;
  end if;

  if v_task.recurrence is null then
    return null;
  end if;

  v_base := coalesce(v_task.due_at, now());
  v_next := case v_task.recurrence
    when 'daily'    then v_base + interval '1 day'
    when 'weekly'   then v_base + interval '1 week'
    when 'biweekly' then v_base + interval '2 weeks'
    when 'monthly'  then v_base + interval '1 month'
    when 'weekdays' then v_base + case extract(isodow from v_base)::int
                                    when 5 then interval '3 days'
                                    when 6 then interval '2 days'
                                    else interval '1 day' end
  end;
  -- never schedule the next occurrence in the past
  while v_next < now() loop
    v_next := case v_task.recurrence
      when 'daily'    then v_next + interval '1 day'
      when 'weekly'   then v_next + interval '1 week'
      when 'biweekly' then v_next + interval '2 weeks'
      when 'monthly'  then v_next + interval '1 month'
      when 'weekdays' then v_next + case extract(isodow from v_next)::int
                                      when 5 then interval '3 days'
                                      when 6 then interval '2 days'
                                      else interval '1 day' end
    end;
  end loop;

  insert into public.tasks (org_id, title, description, notes, priority, category, due_at,
                            recurrence, assignee_id, created_via)
  values (v_task.org_id, v_task.title, v_task.description, v_task.notes, v_task.priority,
          v_task.category, v_next, v_task.recurrence, v_task.assignee_id, v_task.created_via)
  returning id into v_new;
  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles                  enable row level security;
alter table public.organizations             enable row level security;
alter table public.organization_members      enable row level security;
alter table public.organization_settings     enable row level security;
alter table public.connected_integrations    enable row level security;
alter table public.integration_credentials   enable row level security;
alter table public.assistant_conversations   enable row level security;
alter table public.assistant_messages        enable row level security;
alter table public.tasks                     enable row level security;
alter table public.task_history              enable row level security;
alter table public.calendar_event_references enable row level security;
alter table public.documents                 enable row level security;
alter table public.knowledge_base_sources    enable row level security;
alter table public.workflows                 enable row level security;
alter table public.workflow_versions         enable row level security;
alter table public.workflow_runs             enable row level security;
alter table public.workflow_steps            enable row level security;
alter table public.approval_requests         enable row level security;
alter table public.action_logs               enable row level security;
alter table public.notifications             enable row level security;
alter table public.usage_records             enable row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.shares_org_with(id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- organizations (created only via create_organization())
create policy organizations_select on public.organizations for select to authenticated
  using (private.is_org_member(id));
create policy organizations_update on public.organizations for update to authenticated
  using (private.has_org_role(id, array['owner', 'admin']))
  with check (private.has_org_role(id, array['owner', 'admin']));

-- organization_members: everyone in the org can see the roster; only owners manage it
create policy members_select on public.organization_members for select to authenticated
  using (private.is_org_member(org_id));
create policy members_insert on public.organization_members for insert to authenticated
  with check (private.has_org_role(org_id, array['owner']));
create policy members_update on public.organization_members for update to authenticated
  using (private.has_org_role(org_id, array['owner'])) with check (private.has_org_role(org_id, array['owner']));
create policy members_delete on public.organization_members for delete to authenticated
  using (private.has_org_role(org_id, array['owner']) or user_id = (select auth.uid()));

-- organization_settings
create policy settings_select on public.organization_settings for select to authenticated
  using (private.is_org_member(org_id));
create policy settings_update on public.organization_settings for update to authenticated
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

-- connected_integrations: members can see status; connect/disconnect only through server functions
create policy integrations_select on public.connected_integrations for select to authenticated
  using (private.is_org_member(org_id));

-- integration_credentials: intentionally NO policies and no grants => service role only.

-- assistant conversations & messages: private to the user who owns them
create policy conversations_select on public.assistant_conversations for select to authenticated
  using (user_id = (select auth.uid()) and private.is_org_member(org_id));
create policy conversations_insert on public.assistant_conversations for insert to authenticated
  with check (user_id = (select auth.uid()) and private.is_org_member(org_id));
create policy conversations_update on public.assistant_conversations for update to authenticated
  using (user_id = (select auth.uid()) and private.is_org_member(org_id))
  with check (user_id = (select auth.uid()) and private.is_org_member(org_id));
create policy conversations_delete on public.assistant_conversations for delete to authenticated
  using (user_id = (select auth.uid()) and private.is_org_member(org_id));

create policy messages_select on public.assistant_messages for select to authenticated
  using (private.is_org_member(org_id) and exists (
    select 1 from public.assistant_conversations c
    where c.id = conversation_id and c.org_id = assistant_messages.org_id and c.user_id = (select auth.uid())));
-- clients may only add *user* messages; assistant/tool messages are written by the server.
create policy messages_insert on public.assistant_messages for insert to authenticated
  with check (role = 'user' and private.is_org_member(org_id) and exists (
    select 1 from public.assistant_conversations c
    where c.id = conversation_id and c.org_id = assistant_messages.org_id and c.user_id = (select auth.uid())));

-- tasks
create policy tasks_select on public.tasks for select to authenticated
  using (private.is_org_member(org_id));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (private.is_org_member(org_id));
create policy tasks_update on public.tasks for update to authenticated
  using (private.is_org_member(org_id)) with check (private.is_org_member(org_id));
create policy tasks_delete on public.tasks for delete to authenticated
  using (private.has_org_role(org_id, array['owner', 'admin']) or created_by = (select auth.uid()));

create policy task_history_select on public.task_history for select to authenticated
  using (private.is_org_member(org_id));

-- calendar references: read-only for clients
create policy calendar_refs_select on public.calendar_event_references for select to authenticated
  using (private.is_org_member(org_id));

-- documents & knowledge base
create policy documents_select on public.documents for select to authenticated
  using (private.is_org_member(org_id));
create policy documents_insert on public.documents for insert to authenticated
  with check (private.is_org_member(org_id) and uploaded_by = (select auth.uid()));
create policy documents_update on public.documents for update to authenticated
  using (private.is_org_member(org_id)) with check (private.is_org_member(org_id));
create policy documents_delete on public.documents for delete to authenticated
  using (private.has_org_role(org_id, array['owner', 'admin']) or uploaded_by = (select auth.uid()));

create policy kb_select on public.knowledge_base_sources for select to authenticated
  using (private.is_org_member(org_id));
create policy kb_insert on public.knowledge_base_sources for insert to authenticated
  with check (private.has_org_role(org_id, array['owner', 'admin']));
create policy kb_update on public.knowledge_base_sources for update to authenticated
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));
create policy kb_delete on public.knowledge_base_sources for delete to authenticated
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- workflows: admins author; everyone in the org can see them and their runs
create policy workflows_select on public.workflows for select to authenticated
  using (private.is_org_member(org_id));
create policy workflows_insert on public.workflows for insert to authenticated
  with check (private.has_org_role(org_id, array['owner', 'admin']));
create policy workflows_update on public.workflows for update to authenticated
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));
create policy workflows_delete on public.workflows for delete to authenticated
  using (private.has_org_role(org_id, array['owner', 'admin']));

create policy workflow_versions_select on public.workflow_versions for select to authenticated
  using (private.is_org_member(org_id));
create policy workflow_versions_insert on public.workflow_versions for insert to authenticated
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy workflow_runs_select on public.workflow_runs for select to authenticated
  using (private.is_org_member(org_id));
create policy workflow_steps_select on public.workflow_steps for select to authenticated
  using (private.is_org_member(org_id));

-- approvals: visible to the org; a decision may be made by admins or the person the request is for
create policy approvals_select on public.approval_requests for select to authenticated
  using (private.is_org_member(org_id));
create policy approvals_update on public.approval_requests for update to authenticated
  using (
    status = 'pending'
    and (private.has_org_role(org_id, array['owner', 'admin']) or requested_by = (select auth.uid()))
  )
  with check (
    private.has_org_role(org_id, array['owner', 'admin']) or requested_by = (select auth.uid())
  );

-- append-only logs, read-only for clients
create policy action_logs_select on public.action_logs for select to authenticated
  using (private.is_org_member(org_id));

create policy notifications_select on public.notifications for select to authenticated
  using (private.is_org_member(org_id) and (user_id is null or user_id = (select auth.uid())));
create policy notifications_update on public.notifications for update to authenticated
  using (private.is_org_member(org_id) and (user_id is null or user_id = (select auth.uid())))
  with check (private.is_org_member(org_id) and (user_id is null or user_id = (select auth.uid())));

create policy usage_select on public.usage_records for select to authenticated
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- ---------------------------------------------------------------------------
-- Privileges: deny by default, then grant exactly what the client needs.
-- RLS is the row filter; these grants are the column/operation filter.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
-- future objects created by migrations are also closed by default
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

grant select on public.profiles to authenticated;
grant update (full_name, avatar_url, timezone) on public.profiles to authenticated;

grant select on public.organizations to authenticated;
grant update (name) on public.organizations to authenticated;

grant select, insert, delete on public.organization_members to authenticated;
grant update (role) on public.organization_members to authenticated;

grant select on public.organization_settings to authenticated;
grant update (timezone, business_hours, ai_model, approval_policy, briefing_enabled)
  on public.organization_settings to authenticated;

grant select on public.connected_integrations to authenticated;

grant select, insert, delete on public.assistant_conversations to authenticated;
grant update (title) on public.assistant_conversations to authenticated;
grant select, insert on public.assistant_messages to authenticated;

grant select, insert, delete on public.tasks to authenticated;
grant update (title, description, notes, status, priority, category, due_at, recurrence, assignee_id)
  on public.tasks to authenticated;
grant select on public.task_history to authenticated;

grant select on public.calendar_event_references to authenticated;

grant select, insert, delete on public.documents to authenticated;
grant update (name, category) on public.documents to authenticated;
grant select, insert, delete on public.knowledge_base_sources to authenticated;
grant update (kind, title, content, is_active) on public.knowledge_base_sources to authenticated;

grant select, insert, delete on public.workflows to authenticated;
grant update (name, description, enabled, trigger_type, trigger_config, current_version)
  on public.workflows to authenticated;
grant select, insert on public.workflow_versions to authenticated;
grant select on public.workflow_runs, public.workflow_steps to authenticated;

grant select on public.approval_requests to authenticated;
grant update (status, decision_note) on public.approval_requests to authenticated;

grant select on public.action_logs to authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant select on public.usage_records to authenticated;

grant execute on function public.create_organization(text, text) to authenticated;
grant execute on function public.complete_task(uuid) to authenticated;
