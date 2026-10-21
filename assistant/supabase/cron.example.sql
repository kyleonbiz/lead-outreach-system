-- Run ONCE per project (SQL editor), after deploying the workflow-tick function. Not a migration because it
-- contains project-specific values. Requires the pg_cron and pg_net extensions (Database -> Extensions).
--
-- 1. Store the shared secret in Vault:   select vault.create_secret('<same value as the CRON_SECRET function secret>', 'cron_secret');
-- 2. Replace <PROJECT_REF> below and run the schedule.

select cron.schedule(
  'workflow-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/workflow-tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- To stop:  select cron.unschedule('workflow-tick');
