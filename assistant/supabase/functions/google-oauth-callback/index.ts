import { guarded, json, serviceClient } from '../_shared/runtime.ts'
import { callbackDeps } from '../_shared/wiring.oauth.ts'
import { handleOAuthCallback } from '../_shared/core/handlers/oauth.ts'

// GET from Google's redirect. Authenticated by the signed `state`, not by a JWT (verify_jwt = false).
Deno.serve(guarded(async (req) => {
  const q = new URL(req.url).searchParams
  return json(await handleOAuthCallback(callbackDeps(serviceClient()), { code: q.get('code'), state: q.get('state'), error: q.get('error') }))
}))
