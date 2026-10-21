import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '@/lib/supabase'
import type { Membership, OrgSettings, Role } from '@/lib/types'
import { useAuth } from '@/features/auth/AuthProvider'
import { Spinner } from '@/components/ui'

interface Profile { id: string; full_name: string | null; timezone: string }

interface OrgState {
  orgId: string
  orgName: string
  role: Role
  isAdmin: boolean
  memberships: Membership[]
  profile: Profile | null
  settings: OrgSettings | null
  switchOrg: (id: string) => void
  refresh: () => Promise<void>
}

const Ctx = createContext<OrgState | null>(null)
const STORAGE_KEY = 'currentOrgId'

const readSaved = () => { try { return localStorage.getItem(STORAGE_KEY) } catch { return null } }
const writeSaved = (v: string) => { try { localStorage.setItem(STORAGE_KEY, v) } catch { /* private mode */ } }

/** Loads memberships; renders `empty` when the user belongs to no organization yet. */
export function OrgProvider({ children, empty }: { children: ReactNode; empty: ReactNode }) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const uid = user!.id
  const [selected, setSelected] = useState<string | null>(readSaved)

  const memberships = useQuery({
    queryKey: ['memberships', uid],
    queryFn: async () => {
      const { data, error } = await db()
        .from('organization_members')
        .select('org_id, role, organizations(id, name)')
        .eq('user_id', uid)
      if (error) throw error
      return (data ?? []) as unknown as Membership[]
    },
  })

  const current = useMemo(() => {
    const list = memberships.data ?? []
    return list.find((m) => m.org_id === selected) ?? list[0] ?? null
  }, [memberships.data, selected])

  useEffect(() => { if (current) writeSaved(current.org_id) }, [current])

  const profile = useQuery({
    queryKey: ['profile', uid],
    queryFn: async () => {
      const { data, error } = await db().from('profiles').select('id, full_name, timezone').eq('id', uid).maybeSingle()
      if (error) throw error
      return data as Profile | null
    },
  })

  const settings = useQuery({
    queryKey: ['settings', current?.org_id],
    enabled: !!current,
    queryFn: async () => {
      const { data, error } = await db().from('organization_settings').select('*').eq('org_id', current!.org_id).maybeSingle()
      if (error) throw error
      return data as OrgSettings | null
    },
  })

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['memberships'] })
    await qc.invalidateQueries({ queryKey: ['profile'] })
    await qc.invalidateQueries({ queryKey: ['settings'] })
  }, [qc])

  if (memberships.isLoading) return <Spinner label="Loading your workspace" />
  if (memberships.isError) {
    return <p role="alert" className="p-6 text-sm text-danger">Could not load your workspace: {(memberships.error as Error).message}</p>
  }
  if (!current) return <>{empty}</>

  const value: OrgState = {
    orgId: current.org_id,
    orgName: current.organizations.name,
    role: current.role,
    isAdmin: current.role === 'owner' || current.role === 'admin',
    memberships: memberships.data ?? [],
    profile: profile.data ?? null,
    settings: settings.data ?? null,
    switchOrg: (id) => { setSelected(id); writeSaved(id) },
    refresh,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useOrg() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useOrg outside OrgProvider')
  return v
}
