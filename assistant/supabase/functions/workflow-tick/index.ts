import { env, guarded, json, serviceClient } from '../_shared/runtime.ts'
import { secretsMatch, tickDeps } from '../_shared/wiring.workflows.ts'
import { handleTick } from '../_shared/core/handlers/workflows.ts'

// Invoked every minute by pg_cron (see supabase/cron.example.sql). verify_jwt = false: authenticated by CRON_SECRET.
Deno.serve(guarded(async (req) => {
  if (!env('CRON_SECRET')) return json({ status: 503, body: { error: 'CRON_SECRET is not configured', code: 'not_configured', missing: ['CRON_SECRET'] } })
  return json(await handleTick(tickDeps(serviceClient(), secretsMatch(req.headers.get('x-cron-secret'), env('CRON_SECRET')))))
}))
