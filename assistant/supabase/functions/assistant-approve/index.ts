import { guarded, json, readJson, serviceClient, userClient, verifiedUserId } from '../_shared/runtime.ts'
import { buildApproveDeps } from '../_shared/wiring.ts'
import { handleDecision } from '../_shared/core/handlers/approve.ts'

Deno.serve(guarded(async (req) => {
  const client = userClient(req)
  const userId = await verifiedUserId(client, req)
  return json(await handleDecision(buildApproveDeps({ userId, client, svc: serviceClient() }), await readJson(req)))
}))
