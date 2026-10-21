import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { db } from '@/lib/supabase'

interface AuthState {
  user: User | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<string | null>
  /** Resolves to { error } or { needsConfirmation } when the project requires email confirmation. */
  signUp: (email: string, password: string, fullName: string) => Promise<{ error?: string; needsConfirmation?: boolean }>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const client = db()
    client.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data } = client.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      user: session?.user ?? null,
      loading,
      signIn: async (email, password) => {
        const { error } = await db().auth.signInWithPassword({ email, password })
        return error?.message ?? null
      },
      signUp: async (email, password, fullName) => {
        const { data, error } = await db().auth.signUp({
          email, password, options: { data: { full_name: fullName }, emailRedirectTo: window.location.origin },
        })
        if (error) return { error: error.message }
        return { needsConfirmation: !data.session }
      },
      signOut: async () => { await db().auth.signOut() },
    }),
    [session, loading],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
