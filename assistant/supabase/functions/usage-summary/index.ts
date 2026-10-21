import { guarded, json, readJson, userClient, verifiedUserId } from '../_shared/runtime.ts'
import { usageDeps } from '../_shared/wiring.usage.ts'
import { handleUsage } from '../_shared/core/handlers/usage.ts'

// Owners and admins only. Reads usage with the caller's own token and adds the server's daily token limit.
Deno.serve(guarded(async (req) => {
  const client = userClient(req)
  return json(await handleUsage(usageDeps(await verifiedUserId(client, req), client), await readJson(req)))
}))
