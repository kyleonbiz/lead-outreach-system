import { describe, expect, it } from 'vitest'
import { readEnv } from './env'

describe('readEnv', () => {
  it('accepts a valid configuration', () => {
    const r = readEnv({ VITE_SUPABASE_URL: 'https://abc.supabase.co', VITE_SUPABASE_ANON_KEY: 'x'.repeat(30) })
    expect(r.ok).toBe(true)
  })
  it('reports exactly which variables are missing', () => {
    const r = readEnv({ VITE_SUPABASE_URL: 'nope' })
    expect(r).toEqual({ ok: false, missing: ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'] })
  })
})
