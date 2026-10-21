import { guarded, json, serviceClient } from '../_shared/runtime.ts'
import { callbackDeps } from '../_shared/wiring.oauth.ts'
import { handleOAuthCallback } from '../_shared/core/handlers/oauth.ts'

// GET from Microsoft's redirect. Authenticated by the signed `state`, not by a JWT (verify_jwt = false).
// The handler is shared with Google: the signed state says which provider started the flow.
Deno.serve(guarded(async (req) => {
  const q = new URL(req.url).searchParams
  return json(await handleOAuthCallback(callbackDeps(serviceClient()), { code: q.get('code'), state: q.get('state'), error: q.get('error') }))
}))
