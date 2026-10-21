import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '@/lib/supabase'
import { callFunction } from '@/features/assistant/api'
import type { Role } from '@/lib/types'

export interface Member { user_id: string; full_name: string | null; email: string | null; role: Role; joined_at: string }
export interface Invitation { id: string; email: string; role: 'admin' | 'member'; created_at: string; expires_at: string; accepted_at: string | null; revoked_at: string | null }
export interface InviteResult { id: string; emailed: boolean; reason?: string; link?: string }

export const memberName = (m: Pick<Member, 'full_name' | 'email'> | undefined): string =>
  m?.full_name?.trim() || m?.email?.split('@')[0] || 'Team member'

export function useMembers(orgId: string) {
  return useQuery({
    queryKey: ['members', orgId],
    queryFn: async () => {
      const { data, error } = await db().rpc('org_members', { p_org: orgId })
      if (error) throw new Error(error.message)
      return (data ?? []) as Member[]
    },
  })
}

export function useInvitations(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['invitations', orgId], enabled,
    queryFn: async () => {
      const { data, error } = await db().from('organization_invitations')
        .select('id, email, role, created_at, expires_at, accepted_at, revoked_at')
        .eq('org_id', orgId).is('accepted_at', null).is('revoked_at', null).gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
      if (error) throw new Error(error.message)
      return (data ?? []) as Invitation[]
    },
  })
}

export function useInvite(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { email: string; role: 'admin' | 'member' }) => callFunction<InviteResult>('invite-member', { org_id: orgId, ...v }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['invitations', orgId] }),
  })
}

export function useRevokeInvitation(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db().rpc('revoke_invitation', { p_id: id })
      if (error) throw new Error(error.message)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['invitations', orgId] }),
  })
}

export function useChangeRole(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { userId: string; role: Role }) => {
      const { data, error } = await db().from('organization_members').update({ role: v.role }).eq('org_id', orgId).eq('user_id', v.userId).select('user_id')
      if (error) throw new Error(error.message)
      if (!data?.length) throw new Error('You do not have permission to change that role.')
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: ['members', orgId] }); qc.invalidateQueries({ queryKey: ['memberships'] }) },
  })
}

export function useRemoveMember(orgId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (userId: string) => {
      const { data, error } = await db().from('organization_members').delete().eq('org_id', orgId).eq('user_id', userId).select('user_id')
      if (error) throw new Error(error.message)
      if (!data?.length) throw new Error('You do not have permission to remove that person.')
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: ['members', orgId] }); qc.invalidateQueries({ queryKey: ['memberships'] }) },
  })
}

export function useAcceptInvitation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (token: string) => {
      const { data, error } = await db().rpc('accept_invitation', { p_token: token })
      if (error) throw new Error(error.message)
      return data as { org_id: string; role: Role }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memberships'] }),
  })
}
