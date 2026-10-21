import { guarded, json, readJson, serviceClient, userClient, verifiedUserId } from '../_shared/runtime.ts'
import { channelDeps } from '../_shared/wiring.notify.ts'
import { handleChannels } from '../_shared/core/handlers/notifyChannels.ts'

// Create / update / delete / test Slack & Teams webhook channels. Admin-only; the webhook URL is validated,
// encrypted and never returned to the browser.
Deno.serve(guarded(async (req) => {
  const client = userClient(req)
  return json(await handleChannels(channelDeps(await verifiedUserId(client, req), client, serviceClient()), await readJson(req)))
}))
