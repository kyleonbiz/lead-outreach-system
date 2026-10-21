-- 0004_email_rules.sql
-- User-configurable rules for flagging urgent messages / VIP senders (parsed + validated server-side).
alter table public.organization_settings
  add column email_rules jsonb not null default '{}'::jsonb
  check (jsonb_typeof(email_rules) = 'object' and pg_column_size(email_rules) < 20000);

grant update (email_rules) on public.organization_settings to authenticated;
