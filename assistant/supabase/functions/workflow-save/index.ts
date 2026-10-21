import { guarded, json, readJson, serviceClient, userClient, verifiedUserId } from '../_shared/runtime.ts'
import { saveDeps } from '../_shared/wiring.workflows.ts'
import { handleWorkflowSave } from '../_shared/core/handlers/workflows.ts'

Deno.serve(guarded(async (req) => {
  const client = userClient(req)
  return json(await handleWorkflowSave(saveDeps(await verifiedUserId(client, req), client, serviceClient()), await readJson(req)))
}))
