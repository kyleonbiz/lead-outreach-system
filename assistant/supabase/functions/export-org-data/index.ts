import { guarded, json, readJson, serviceClient, userClient, verifiedUserId, zipResponse } from '../_shared/runtime.ts'
import { exportDeps } from '../_shared/wiring.privacy.ts'
import { handleExport } from '../_shared/core/handlers/dataExport.ts'

// Owners: all organization data. Owners and admins: the audit log. Reads use the caller's own token (RLS).
Deno.serve(guarded(async (req) => {
  const client = userClient(req)
  const r = await handleExport(exportDeps(await verifiedUserId(client, req), client, serviceClient()), await readJson(req))
  return 'zip' in r ? zipResponse(r.zip, r.filename) : json(r)
}))
