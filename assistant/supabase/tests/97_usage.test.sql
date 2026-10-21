\o /dev/null
begin;
create schema if not exists t;
grant usage on schema t to authenticated, anon, service_role;
create or replace function t.ok(cond boolean, name text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FAIL: %', name; end if; raise notice 'ok - %', name; end $$;
create or replace function t.throws(sql text, name text, expected_state text default null) returns void language plpgsql as $$
declare st text;
begin
  begin execute sql;
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    if expected_state is not null and st <> expected_state then raise exception 'FAIL: % (expected %, got % : %)', name, expected_state, st, sqlerrm; end if;
    raise notice 'ok - % [%]', name, st; return;
  end;
  raise exception 'FAIL: % (succeeded but must be rejected)', name;
end $$;
create or replace function t.as_user(uid uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', uid::text, true); execute 'reset role'; execute 'set local role authenticated'; end $$;
create or replace function t.as_anon() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', true); execute 'reset role'; execute 'set local role anon'; end $$;
create or replace function t.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', true); execute 'reset role'; execute 'set local role service_role'; end $$;
create or replace function t.cnt(sql text) returns bigint language plpgsql as $$
declare n bigint; begin execute 'select count(*) from (' || sql || ') q' into n; return n; end $$;

insert into auth.users (id, email) values
  ('aaaaaaaa-c000-0000-0000-000000000001', 'owner@a.test'), ('aaaaaaaa-c000-0000-0000-000000000002', 'admin@a.test'),
  ('aaaaaaaa-c000-0000-0000-000000000003', 'member@a.test'), ('bbbbbbbb-c000-0000-0000-000000000001', 'owner@b.test');
create temp table ctx(k text primary key, v uuid);
grant all on ctx to authenticated, service_role;
select t.as_user('aaaaaaaa-c000-0000-0000-000000000001');
insert into ctx select 'A', public.create_organization('Org A');
insert into public.organization_members (org_id, user_id, role) select v, 'aaaaaaaa-c000-0000-0000-000000000002', 'admin' from ctx where k='A';
insert into public.organization_members (org_id, user_id, role) select v, 'aaaaaaaa-c000-0000-0000-000000000003', 'member' from ctx where k='A';
select t.as_user('bbbbbbbb-c000-0000-0000-000000000001');
insert into ctx select 'B', public.create_organization('Org B');

-- ===== data: usage over several UTC days, two models, tools, workflow runs, documents ===========
select t.as_service();
insert into public.usage_records (org_id, kind, quantity, model, created_at)
  select v, x.kind, x.q, x.m, (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC') + make_interval(days => -x.d, hours => 3)
  from ctx, (values ('llm_input_tokens', 1000, 'model-a', 0), ('llm_output_tokens', 400, 'model-a', 0), ('llm_input_tokens', 500, 'model-b', 0), ('llm_output_tokens', 100, 'model-b', 0),
                    ('tool_call', 1, null, 0), ('tool_call', 1, null, 0), ('tool_call', 1, null, 0),
                    ('llm_input_tokens', 2000, 'model-a', 2), ('llm_output_tokens', 800, 'model-a', 2), ('tool_call', 1, null, 2),
                    ('llm_input_tokens', 7000, 'model-a', 40), ('llm_output_tokens', 3000, 'model-a', 40)) x(kind, q, m, d)
  where ctx.k = 'A';
insert into public.usage_records (org_id, kind, quantity, model) select v, 'llm_input_tokens', 999999, 'model-b' from ctx where k = 'B';
insert into public.action_logs (org_id, actor_type, category, tool_name, action, status)
  select v, 'assistant', 'tool_call', x.tool, x.tool, x.st from ctx, (values ('tasks.create', 'success'), ('tasks.create', 'success'), ('tasks.create', 'failure'), ('email.search', 'success')) x(tool, st) where ctx.k = 'A';
insert into public.action_logs (org_id, actor_type, category, tool_name, action, status) select v, 'assistant', 'audit', 'not.a.tool', 'x', 'success' from ctx where k = 'A';
insert into public.action_logs (org_id, actor_type, category, tool_name, action, status) select v, 'assistant', 'tool_call', 'other.org.tool', 'x', 'success' from ctx where k = 'B';
insert into public.documents (org_id, name, storage_path, size_bytes) select v, 'a.pdf', v::text || '/a.pdf', 1500 from ctx where k = 'A';
insert into public.documents (org_id, name, storage_path, size_bytes) select v, 'b.pdf', v::text || '/b.pdf', 2500 from ctx where k = 'A';
insert into public.documents (org_id, name, storage_path, size_bytes) select v, 'c.pdf', v::text || '/c.pdf', 99999 from ctx where k = 'B';
insert into public.workflows (id, org_id, name) select 'aaaa0000-0000-4000-8000-0000000000c1', v, 'WF' from ctx where k='A';
insert into public.workflow_runs (org_id, workflow_id, status) select v, 'aaaa0000-0000-4000-8000-0000000000c1', s from ctx, (values ('succeeded'), ('succeeded'), ('failed')) x(s) where ctx.k='A';

-- ===== who may see it ===========================================================
select t.as_user('aaaaaaaa-c000-0000-0000-000000000003');
select t.throws($$select public.usage_summary((select v from ctx where k='A'))$$, 'a plain member cannot see usage', '42501');
select t.as_user('bbbbbbbb-c000-0000-0000-000000000001');
select t.throws($$select public.usage_summary((select v from ctx where k='A'))$$, 'another organization''s owner cannot see this usage', '42501');
select t.throws($$select public.usage_summary('00000000-0000-0000-0000-000000000000')$$, 'an unknown organization looks the same', '42501');
select t.as_anon();
select t.throws($$select public.usage_summary('00000000-0000-0000-0000-000000000000')$$, 'anonymous callers cannot call it', '42501');

-- ===== the numbers ======================================================================
select t.as_user('aaaaaaaa-c000-0000-0000-000000000002');   -- an admin
create temp table s30 as select public.usage_summary((select v from ctx where k='A'), 30) as j;
grant all on s30 to authenticated;
select t.ok((select j ->> 'window_days' from s30) = '30', 'the window is reported');
select t.ok(jsonb_array_length((select j -> 'daily' from s30)) = 30, 'one row per UTC day, with empty days filled in');
select t.ok((select (j -> 'daily' -> 29 ->> 'day') from s30) = to_char(now() at time zone 'UTC', 'YYYY-MM-DD'), 'the last row is today (UTC)');
select t.ok((select (j -> 'daily' -> 29 ->> 'input_tokens')::int from s30) = 1500 and (select (j -> 'daily' -> 29 ->> 'output_tokens')::int from s30) = 500, 'today''s tokens add up across models');
select t.ok((select (j -> 'daily' -> 29 ->> 'tool_calls')::int from s30) = 3, 'and today''s tool calls');
select t.ok((select (j -> 'daily' -> 27 ->> 'input_tokens')::int from s30) = 2000 and (select (j -> 'daily' -> 27 ->> 'tool_calls')::int from s30) = 1, 'a day two days ago is in the right slot');
select t.ok((select (j -> 'daily' -> 28 ->> 'input_tokens')::int from s30) = 0, 'a day with no usage is zero, not missing');
select t.ok((select (j ->> 'tokens_today')::int from s30) = 2000, 'tokens_today counts only the current UTC day (input + output)');
select t.ok((select (j -> 'totals' ->> 'input_tokens')::int from s30) = 10500 + 0 - 7000 and (select (j -> 'totals' ->> 'output_tokens')::int from s30) = 1300 and (select (j -> 'totals' ->> 'tool_calls')::int from s30) = 4, 'totals cover the window only (a record 40 days ago is excluded)');
select t.ok((select (j -> 'by_model' -> 0 ->> 'model') from s30) = 'model-a' and (select (j -> 'by_model' -> 1 ->> 'model') from s30) = 'model-b', 'models are ranked by tokens');
select t.ok((select (j -> 'by_model' -> 0 ->> 'input_tokens')::int from s30) = 3000, 'per-model tokens are summed');
select t.ok((select (j -> 'tools' -> 0 ->> 'tool') from s30) = 'tasks.create' and (select (j -> 'tools' -> 0 ->> 'calls')::int from s30) = 3 and (select (j -> 'tools' -> 0 ->> 'failures')::int from s30) = 1, 'tools are ranked by calls with their failures');
select t.ok((select jsonb_array_length(j -> 'tools') from s30) = 2, 'only real tool calls are listed (audit rows and other organizations are excluded)');
select t.ok((select (j -> 'workflow_runs' ->> 'succeeded')::int from s30) = 2 and (select (j -> 'workflow_runs' ->> 'failed')::int from s30) = 1, 'workflow runs are counted by outcome');
select t.ok((select (j -> 'storage' ->> 'bytes')::int from s30) = 4000 and (select (j -> 'storage' ->> 'documents')::int from s30) = 2, 'storage is this organization''s documents only');
select t.ok((select j::text from s30) not like '%999999%' and (select j::text from s30) not like '%other.org.tool%' and (select j::text from s30) not like '%99999%', 'nothing from another organization leaks in');

-- ===== someone who administers BOTH organizations: RLS shows them both, so the explicit org filter is what keeps them apart ====
select t.as_user('bbbbbbbb-c000-0000-0000-000000000001');
insert into public.organization_members (org_id, user_id, role) select v, 'aaaaaaaa-c000-0000-0000-000000000002', 'admin' from ctx where k='B';
select t.as_user('aaaaaaaa-c000-0000-0000-000000000002');
select t.ok(t.cnt($$select 1 from public.usage_records where kind='llm_input_tokens' and quantity = 999999$$) = 1, 'sanity: this person really can read both organizations'' usage rows');
create temp table s_a as select public.usage_summary((select v from ctx where k='A'), 30) as j;
create temp table s_b as select public.usage_summary((select v from ctx where k='B'), 30) as j;
grant all on s_a, s_b to authenticated;
select t.ok((select (j -> 'totals' ->> 'input_tokens')::int from s_a) = 3500, 'org A''s totals exclude org B even for someone who can see both');
select t.ok((select j -> 'by_model' -> 0 ->> 'model' from s_a) = 'model-a' and (select (j -> 'by_model' -> 0 ->> 'input_tokens')::int from s_a) = 3000, 'org A''s model breakdown excludes org B');
select t.ok((select j::text from s_a) not like '%other.org.tool%' and (select (j -> 'storage' ->> 'bytes')::int from s_a) = 4000 and (select j -> 'workflow_runs' ->> 'succeeded' from s_a) = '2', 'org A''s tools, storage and workflow runs exclude org B');
select t.ok((select (j ->> 'tokens_today')::int from s_a) = 2000, 'org A''s tokens_today excludes org B');
select t.ok((select (j -> 'totals' ->> 'input_tokens')::int from s_b) = 999999 and (select (j -> 'storage' ->> 'bytes')::int from s_b) = 99999, 'and org B''s summary is exactly org B''s');

-- ===== window handling ================================================================
select t.ok(jsonb_array_length((select public.usage_summary((select v from ctx where k='A'), 7) -> 'daily')) = 7, 'a 7-day window has 7 rows');
select t.ok((select (public.usage_summary((select v from ctx where k='A'), 7) -> 'totals' ->> 'input_tokens')::int) = 3500, 'and excludes older records');
select t.ok((select (public.usage_summary((select v from ctx where k='A'), 90) -> 'totals' ->> 'input_tokens')::int) = 10500, 'a 90-day window includes the 40-day-old record');
select t.ok(jsonb_array_length((select public.usage_summary((select v from ctx where k='A'), 0) -> 'daily')) = 1, 'a window below 1 is raised to 1');
select t.ok(jsonb_array_length((select public.usage_summary((select v from ctx where k='A'), 100000) -> 'daily')) = 90, 'a window above 90 is capped');
select t.ok(jsonb_array_length((select public.usage_summary((select v from ctx where k='A'), null) -> 'daily')) = 30, 'null means 30 days');
select t.as_user('bbbbbbbb-c000-0000-0000-000000000001');
select t.ok((select (public.usage_summary((select v from ctx where k='B'), 30) -> 'totals' ->> 'input_tokens')::int) = 999999 and (select (public.usage_summary((select v from ctx where k='B'), 30) -> 'tools' -> 0 ->> 'tool')) = 'other.org.tool', 'the other organization sees exactly its own data');

-- an organization with no usage at all
select t.as_service();
insert into auth.users (id, email) values ('dddddddd-c000-0000-0000-000000000001', 'new@d.test');
select t.as_user('dddddddd-c000-0000-0000-000000000001');
insert into ctx select 'D', public.create_organization('Org D');
select t.ok((select public.usage_summary((select v from ctx where k='D'), 3) ->> 'tokens_today')::int = 0 and jsonb_array_length((select public.usage_summary((select v from ctx where k='D'), 3) -> 'daily')) = 3
        and (select public.usage_summary((select v from ctx where k='D'), 3) -> 'tools') = '[]'::jsonb and (select public.usage_summary((select v from ctx where k='D'), 3) -> 'storage' ->> 'bytes')::int = 0, 'an empty organization gets zeros and empty lists, not nulls or errors');

-- ===== the aggregate used to enforce the daily cap =========================================
select t.as_service();
select t.ok((select public.tokens_used_today((select v from ctx where k='A'))) = 2000, 'tokens_used_today matches the screen');
-- 6,000 records in one day: the old code summed at most 5,000 rows and under-counted
insert into public.usage_records (org_id, kind, quantity, model) select v, 'llm_input_tokens', 10, 'model-a' from ctx, generate_series(1, 6000) where k = 'A';
select t.ok((select public.tokens_used_today((select v from ctx where k='A'))) = 2000 + 60000, 'no 5,000-row ceiling: 6,000 more records are all counted');
select t.ok((select public.tokens_used_today((select v from ctx where k='D'))) = 0, 'and other organizations do not count');
select t.as_user('aaaaaaaa-c000-0000-0000-000000000001');
select t.throws($$select public.tokens_used_today((select v from ctx where k='A'))$$, 'clients cannot call the enforcement aggregate', '42501');
rollback;
