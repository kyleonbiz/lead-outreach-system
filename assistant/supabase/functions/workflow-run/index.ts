import { guarded, json, readJson, serviceClient, userClient, verifiedUserId } from '../_shared/runtime.ts'
import { runDeps } from '../_shared/wiring.workflows.ts'
import { handleWorkflowRun } from '../_shared/core/handlers/workflows.ts'

Deno.serve(guarded(async (req) => {
  const client = userClient(req)
  return json(await handleWorkflowRun(runDeps(await verifiedUserId(client, req), client, serviceClient()), await readJson(req)))
}))
