-- 0006_workflow_engine.sql
-- Durable run queue, event dispatch and approval resume for workflows.
-- Definitions are written ONLY by the validating `workflow-save` function (service role): clients can no longer
-- insert workflows/versions or change trigger/definition columns, so unvalidated definitions cannot be stored by a client.

alter table public.workflows
  add column kind text not null default 'custom' check (kind in ('custom', 'daily_briefing'));
create unique index workflows_one_briefing_idx on public.workflows (org_id) where kind = 'daily_briefing';

alter table public.workflow_runs
  add column locked_until timestamptz,
  add column next_attempt_at timestamptz,
  add column event jsonb;
create index workflow_runs_claim_idx on public.workflow_runs (status, next_attempt_at, locked_until)
  where status in ('queued', 'running');

alter table public.workflow_steps add column next_attempt_at timestamptz;
alter table public.approval_requests add column workflow_step_key text;

revoke insert on public.workflows from authenticated;
revoke update (trigger_type, trigger_config, current_version) on public.workflows from authenticated;
revoke insert on public.workflow_versions from authenticated;

-- ---------------------------------------------------------------- events
create table public.workflow_events (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  type          text not null check (type in ('task.overdue', 'document.ready')),
  payload       jsonb not null default '{}'::jsonb,
  dedupe_key    text not null,
  created_at    timestamptz not null default now(),
  processed_at  timestamptz,
  unique (org_id, dedupe_key)
);
create index workflow_events_pending_idx on public.workflow_events (created_at) where processed_at is null;
alter table public.workflow_events enable row level security;
create policy workflow_events_select on public.workflow_events for select to authenticated using (private.is_org_member(org_id));
grant select on public.workflow_events to authenticated;

-- document becomes ready -> event (only if some enabled workflow listens, so the table doesn't grow for nothing)
create or replace function private.emit_document_ready()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status = 'ready' and old.status is distinct from 'ready'
     and exists (select 1 from public.workflows w where w.org_id = new.org_id and w.enabled
                 and w.trigger_type = 'event' and w.trigger_config ->> 'event' = 'document.ready') then
    insert into public.workflow_events (org_id, type, payload, dedupe_key)
    values (new.org_id, 'document.ready', jsonb_build_object('document_id', new.id, 'name', new.name),
            'doc:' || new.id || ':' || extract(epoch from new.updated_at)::bigint)
    on conflict do nothing;
  end if;
  return null;
end;
$$;
create trigger documents_emit_ready after update on public.documents for each row execute function private.emit_document_ready();

-- ---------------------------------------------------------------- queue functions (service role only)
create or replace function public.enqueue_workflow_run(p_workflow uuid, p_source text, p_key text, p_event jsonb default null)
returns uuid
language plpgsql
set search_path = ''
as $$
declare v_org uuid; v_ver uuid; v_id uuid;
begin
  select w.org_id, v.id into v_org, v_ver
  from public.workflows w
  join public.workflow_versions v on v.workflow_id = w.id and v.version = w.current_version
  where w.id = p_workflow;
  if v_org is null then return null; end if;

  insert into public.workflow_runs (org_id, workflow_id, version_id, trigger_source, idempotency_key, status, scheduled_for, event)
  values (v_org, p_workflow, v_ver, p_source, p_key, 'queued', now(), p_event)
  on conflict (workflow_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_id;
  return v_id;   -- null = this key was already enqueued (duplicate trigger)
end;
$$;

create or replace function public.claim_workflow_runs(p_limit int default 3, p_lease_seconds int default 300)
returns setof public.workflow_runs
language plpgsql
set search_path = ''
as $$
begin
  return query
  update public.workflow_runs r
     set status = 'running',
         locked_until = now() + make_interval(secs => p_lease_seconds),
         started_at = coalesce(r.started_at, now()),
         attempt = r.attempt + case when r.status = 'running' then 1 else 0 end   -- a reclaimed (crashed) run counts as another attempt
   where r.id in (
     select id from public.workflow_runs
      where (status = 'queued' and (next_attempt_at is null or next_attempt_at <= now()))
         or (status = 'running' and locked_until < now())
      order by created_at
      for update skip locked
      limit least(greatest(p_limit, 1), 20))
  returning r.*;
end;
$$;

create or replace function public.resume_workflow_step(p_run uuid, p_step text, p_status text, p_output jsonb default null, p_error text default null)
returns boolean
language plpgsql
set search_path = ''
as $$
declare v_n int;
begin
  if p_status not in ('succeeded', 'failed') then raise exception 'invalid status' using errcode = '22023'; end if;
  update public.workflow_steps set status = p_status, output = coalesce(p_output, output), error = p_error, finished_at = now()
   where run_id = p_run and step_key = p_step and status = 'waiting_approval';
  get diagnostics v_n = row_count;
  if v_n = 0 then return false; end if;
  update public.workflow_runs set status = 'queued', next_attempt_at = null where id = p_run and status = 'waiting_approval';
  return true;
end;
$$;

create or replace function public.dispatch_workflow_events(p_limit int default 50)
returns int
language plpgsql
set search_path = ''
as $$
declare e record; w record; v_n int := 0;
begin
  -- surface overdue tasks as events, but only for organizations with a listening workflow
  insert into public.workflow_events (org_id, type, payload, dedupe_key)
  select t.org_id, 'task.overdue', jsonb_build_object('task_id', t.id, 'title', t.title, 'due_at', t.due_at),
         'overdue:' || t.id || ':' || to_char(t.due_at at time zone 'UTC', 'YYYY-MM-DD')
  from public.tasks t
  where t.status in ('todo', 'in_progress', 'blocked') and t.due_at < now()
    and exists (select 1 from public.workflows wf where wf.org_id = t.org_id and wf.enabled and wf.trigger_type = 'event' and wf.trigger_config ->> 'event' = 'task.overdue')
  limit 200
  on conflict do nothing;

  for e in select * from public.workflow_events where processed_at is null order by created_at for update skip locked limit least(p_limit, 200) loop
    for w in select id from public.workflows where org_id = e.org_id and enabled and trigger_type = 'event' and trigger_config ->> 'event' = e.type loop
      perform public.enqueue_workflow_run(w.id, 'event', 'event:' || e.id || ':' || w.id, e.payload);
      v_n := v_n + 1;
    end loop;
    update public.workflow_events set processed_at = now() where id = e.id;
  end loop;
  return v_n;
end;
$$;

revoke all on function public.enqueue_workflow_run(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_workflow_runs(int, int) from public, anon, authenticated;
revoke all on function public.resume_workflow_step(uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.dispatch_workflow_events(int) from public, anon, authenticated;
grant execute on function public.enqueue_workflow_run(uuid, text, text, jsonb) to service_role;
grant execute on function public.claim_workflow_runs(int, int) to service_role;
grant execute on function public.resume_workflow_step(uuid, text, text, jsonb, text) to service_role;
grant execute on function public.dispatch_workflow_events(int) to service_role;
