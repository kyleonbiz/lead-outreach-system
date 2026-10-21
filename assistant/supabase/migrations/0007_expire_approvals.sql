-- 0007_expire_approvals.sql
-- Approvals that nobody decides must not block things forever: mark them expired and fail any workflow step
-- that was waiting on them (the run then continues or fails according to the step's on_failure).

create or replace function public.expire_approvals()
returns int
language plpgsql
set search_path = ''
as $$
declare a record; n int := 0;
begin
  for a in
    select id, workflow_run_id, workflow_step_key from public.approval_requests
     where status = 'pending' and expires_at < now()
     for update skip locked
  loop
    update public.approval_requests set status = 'expired' where id = a.id;
    if a.workflow_run_id is not null and a.workflow_step_key is not null then
      perform public.resume_workflow_step(a.workflow_run_id, a.workflow_step_key, 'failed', null, 'The approval expired before it was decided');
    end if;
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.expire_approvals() from public, anon, authenticated;
grant execute on function public.expire_approvals() to service_role;
