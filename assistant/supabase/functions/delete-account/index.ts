import { guarded, json, readJson, serviceClient, userClient, verifiedUser } from '../_shared/runtime.ts'
import { accountDeletionDeps } from '../_shared/wiring.privacy.ts'
import { handleAccountDeletion } from '../_shared/core/handlers/accountDeletion.ts'

// Irreversible. The person to delete is always the verified caller; the body can only confirm, never name a user.
Deno.serve(guarded(async (req) => {
  const client = userClient(req)
  return json(await handleAccountDeletion(accountDeletionDeps(await verifiedUser(client, req), serviceClient()), await readJson(req)))
}))
