import { guarded, json, readJson, serviceClient, userClient, verifiedUserId } from '../_shared/runtime.ts'
import { disconnectDeps } from '../_shared/wiring.oauth.ts'
import { handleDisconnect } from '../_shared/core/handlers/oauth.ts'

Deno.serve(guarded(async (req) => {
  const client = userClient(req)
  return json(await handleDisconnect(disconnectDeps(await verifiedUserId(client, req), client, serviceClient()), await readJson(req)))
}))
