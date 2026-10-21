-- 0012_usage.sql
-- Usage reporting for the admin Usage screen, and the aggregate the daily token cap is enforced with.
--
--   usage_summary(): SECURITY INVOKER, so Row Level Security still applies underneath; owners and admins only.
--     All days are UTC days, which is also what the daily token cap uses, so the screen and the limit always agree.
--   tokens_used_today(): service role only. Replaces summing rows in application code, which was capped at 5,000 rows
--     and therefore under-counted (and so under-enforced) on very busy days.

create or replace function public.usage_summary(p_org uuid, p_days int default 30)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_days int := greatest(1, least(coalesce(p_days, 30), 90));
  -- all arithmetic is on UTC wall-clock timestamps (no time zone), so it can never be shifted by the session's DST rules
  v_today_ts timestamp := date_trunc('day', now() at time zone 'UTC');
  v_today timestamptz := v_today_ts at time zone 'UTC';
  v_from_ts timestamp;
  v_from timestamptz;
  v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not private.has_org_role(p_org, array['owner', 'admin']) then
    raise exception 'Only owners and admins can see usage' using errcode = '42501';
  end if;
  v_from_ts := v_today_ts - make_interval(days => v_days - 1);
  v_from := v_from_ts at time zone 'UTC';

  select jsonb_build_object(
    'window_days', v_days,
    'from', v_from,
    'tokens_today', coalesce((
      select sum(quantity) from public.usage_records
       where org_id = p_org and kind in ('llm_input_tokens', 'llm_output_tokens') and created_at >= v_today), 0),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'day', to_char(d.day, 'YYYY-MM-DD'), 'input_tokens', coalesce(u.input_tokens, 0), 'output_tokens', coalesce(u.output_tokens, 0),
               'tool_calls', coalesce(u.tool_calls, 0)) order by d.day), '[]'::jsonb)
      from generate_series(v_from_ts, v_today_ts, interval '1 day') as d(day)
      left join (
        select date_trunc('day', created_at at time zone 'UTC') as day,
               sum(quantity) filter (where kind = 'llm_input_tokens') as input_tokens,
               sum(quantity) filter (where kind = 'llm_output_tokens') as output_tokens,
               sum(quantity) filter (where kind = 'tool_call') as tool_calls
          from public.usage_records where org_id = p_org and created_at >= v_from group by 1
      ) u on u.day = d.day
    ),
    'totals', (
      select jsonb_build_object(
        'input_tokens', coalesce(sum(quantity) filter (where kind = 'llm_input_tokens'), 0),
        'output_tokens', coalesce(sum(quantity) filter (where kind = 'llm_output_tokens'), 0),
        'tool_calls', coalesce(sum(quantity) filter (where kind = 'tool_call'), 0))
      from public.usage_records where org_id = p_org and created_at >= v_from
    ),
    'by_model', (
      select coalesce(jsonb_agg(jsonb_build_object('model', model, 'input_tokens', i, 'output_tokens', o) order by i + o desc), '[]'::jsonb)
      from (
        select coalesce(model, 'unknown') as model,
               coalesce(sum(quantity) filter (where kind = 'llm_input_tokens'), 0) as i,
               coalesce(sum(quantity) filter (where kind = 'llm_output_tokens'), 0) as o
          from public.usage_records
         where org_id = p_org and created_at >= v_from and kind in ('llm_input_tokens', 'llm_output_tokens')
         group by 1
      ) m
    ),
    'tools', (
      select coalesce(jsonb_agg(jsonb_build_object('tool', tool_name, 'calls', calls, 'failures', failures) order by calls desc, tool_name), '[]'::jsonb)
      from (
        select tool_name, count(*) as calls, count(*) filter (where status = 'failure') as failures
          from public.action_logs
         where org_id = p_org and category = 'tool_call' and tool_name is not null and created_at >= v_from
         group by tool_name order by count(*) desc, tool_name limit 15
      ) t
    ),
    'workflow_runs', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (select status, count(*) as n from public.workflow_runs where org_id = p_org and created_at >= v_from group by status) w
    ),
    'storage', (
      select jsonb_build_object('bytes', coalesce(sum(size_bytes), 0), 'documents', count(*))
      from public.documents where org_id = p_org
    )
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.tokens_used_today(p_org uuid)
returns numeric
language sql stable security definer
set search_path = ''
as $$
  select coalesce(sum(quantity), 0)
    from public.usage_records
   where org_id = p_org
     and kind in ('llm_input_tokens', 'llm_output_tokens')
     and created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC');
$$;

revoke all on function public.usage_summary(uuid, int) from public, anon;
grant execute on function public.usage_summary(uuid, int) to authenticated;
revoke all on function public.tokens_used_today(uuid) from public, anon, authenticated;
grant execute on function public.tokens_used_today(uuid) to service_role;
