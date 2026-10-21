import { guarded, json, readJson, serviceClient, userClient, verifiedUserId } from '../_shared/runtime.ts'
import { inviteDeps } from '../_shared/wiring.invite.ts'
import { handleInvite } from '../_shared/core/handlers/invitations.ts'

// Owner-only. Generates the invitation token, stores only its hash, and e-mails the link.
Deno.serve(guarded(async (req) => {
  const client = userClient(req)
  return json(await handleInvite(inviteDeps(await verifiedUserId(client, req), client, serviceClient()), await readJson(req)))
}))
