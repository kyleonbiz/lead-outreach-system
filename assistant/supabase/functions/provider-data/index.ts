import { guarded, json, readJson, serviceClient, userClient, verifiedUserId } from '../_shared/runtime.ts'
import { providerDataDeps } from '../_shared/wiring.oauth.ts'
import { handleProviderData } from '../_shared/core/handlers/providerData.ts'

Deno.serve(guarded(async (req) => {
  const client = userClient(req)
  return json(await handleProviderData(providerDataDeps(await verifiedUserId(client, req), client, serviceClient()), await readJson(req)))
}))
