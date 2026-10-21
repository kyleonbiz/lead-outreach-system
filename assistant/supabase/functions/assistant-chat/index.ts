import { guarded, json, readJson, serviceClient, userClient, verifiedUserId } from '../_shared/runtime.ts'
import { buildChatDeps } from '../_shared/wiring.ts'
import { handleChat } from '../_shared/core/handlers/chat.ts'

Deno.serve(guarded(async (req) => {
  const client = userClient(req)
  const userId = await verifiedUserId(client, req)
  return json(await handleChat(buildChatDeps({ userId, client, svc: serviceClient() }), await readJson(req)))
}))
