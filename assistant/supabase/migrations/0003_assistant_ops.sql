-- 0003_assistant_ops.sql
-- Server-side task operations used by the assistant tools and workflow engine.
--   * attributes history rows to the right actor ('assistant' / 'workflow')
--   * always scoped by p_org, so even a service-role caller cannot touch another org's task
--   * SECURITY INVOKER: with a user JWT, Row Level Security still applies on top

create or replace function public.agent_task_op(
  p_org uuid, p_actor text, p_op text, p_id uuid default null, p jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_row public.tasks;
  v_n int;
  v_next uuid;
begin
  if p_actor not in ('assistant', 'workflow') then
    raise exception 'invalid actor' using errcode = '22023';
  end if;
  perform set_config('app.actor_type', p_actor, true);

  if p_op = 'create' then
    insert into public.tasks (org_id, title, description, due_at, priority, category, recurrence, status, notes, created_via)
    values (
      p_org, p ->> 'title', p ->> 'description', (p ->> 'due_at')::timestamptz,
      coalesce(p ->> 'priority', 'medium'), p ->> 'category', p ->> 'recurrence',
      coalesce(p ->> 'status', 'todo'), p ->> 'notes', p_actor
    ) returning * into v_row;
    return to_jsonb(v_row);

  elsif p_op = 'update' then
    update public.tasks t set
      title       = case when p ? 'title'       then p ->> 'title'                       else t.title end,
      description = case when p ? 'description' then p ->> 'description'                 else t.description end,
      notes       = case when p ? 'notes'       then p ->> 'notes'                       else t.notes end,
      due_at      = case when p ? 'due_at'      then (p ->> 'due_at')::timestamptz       else t.due_at end,
      priority    = case when p ? 'priority'    then p ->> 'priority'                    else t.priority end,
      category    = case when p ? 'category'    then p ->> 'category'                    else t.category end,
      recurrence  = case when p ? 'recurrence'  then p ->> 'recurrence'                  else t.recurrence end,
      status      = case when p ? 'status'      then p ->> 'status'                      else t.status end
    where t.id = p_id and t.org_id = p_org
    returning * into v_row;
    return case when v_row.id is null then null else to_jsonb(v_row) end;

  elsif p_op = 'complete' then
    if not exists (select 1 from public.tasks where id = p_id and org_id = p_org) then
      return jsonb_build_object('completed', false, 'next_id', null);
    end if;
    v_next := public.complete_task(p_id);
    -- complete_task returns null both for "not completable" and "no next occurrence"
    return jsonb_build_object(
      'completed', exists (select 1 from public.tasks where id = p_id and org_id = p_org and status = 'done'),
      'next_id', v_next
    );

  elsif p_op = 'delete' then
    delete from public.tasks where id = p_id and org_id = p_org;
    get diagnostics v_n = row_count;
    return to_jsonb(v_n > 0);
  end if;

  raise exception 'unknown op %', p_op using errcode = '22023';
end;
$$;

revoke all on function public.agent_task_op(uuid, text, text, uuid, jsonb) from public, anon;
grant execute on function public.agent_task_op(uuid, text, text, uuid, jsonb) to authenticated, service_role;
