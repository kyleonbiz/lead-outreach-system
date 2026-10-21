import { guarded, json, readJson, userClient, verifiedUserId } from '../_shared/runtime.ts'
import { startDeps } from '../_shared/wiring.oauth.ts'
import { handleOAuthStart } from '../_shared/core/handlers/oauth.ts'

Deno.serve(guarded(async (req) => {
  const client = userClient(req)
  return json(await handleOAuthStart(startDeps(await verifiedUserId(client, req), client), await readJson(req)))
}))
