import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Activity, Bot, CalendarDays, CheckSquare, FileText, LayoutDashboard, LogOut, Mail, Menu, Moon, Plug,
  Settings, Sun, Workflow, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Logo } from './Logo'
import { useAuth } from '@/features/auth/AuthProvider'
import { useOrg } from '@/features/org/OrgProvider'

export const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/assistant', label: 'Assistant', icon: Bot },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/email', label: 'Email', icon: Mail },
  { to: '/documents', label: 'Documents', icon: FileText },
  { to: '/workflows', label: 'Workflows', icon: Workflow },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/integrations', label: 'Integrations', icon: Plug },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.getAttribute('data-theme') === 'dark')
  const toggle = () => {
    const next = !dark
    setDark(next)
    document.documentElement.setAttribute('data-theme', next ? 'dark' : 'light')
    try { localStorage.setItem('theme', next ? 'dark' : 'light') } catch { /* ignore */ }
  }
  return { dark, toggle }
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="space-y-0.5">
      {NAV.map(({ to, label, icon: Icon, ...rest }) => (
        <NavLink
          key={to} to={to} end={'end' in rest ? rest.end : false} onClick={onNavigate}
          className={({ isActive }) => cn(
            'flex items-center gap-3 rounded px-3 h-9 text-sm font-medium',
            isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-sunken hover:text-ink',
          )}
        >
          <Icon className="h-4 w-4" aria-hidden /> {label}
        </NavLink>
      ))}
    </nav>
  )
}

export function AppShell() {
  const { user, signOut } = useAuth()
  const { orgName, memberships, orgId, switchOrg } = useOrg()
  const { dark, toggle } = useTheme()
  const [open, setOpen] = useState(false)
  const loc = useLocation()
  useEffect(() => setOpen(false), [loc.pathname])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const sidebar = (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="px-2 pt-1"><Logo /></div>
      <div className="px-2">
        {memberships.length > 1 ? (
          <select
            aria-label="Workspace" value={orgId} onChange={(e) => switchOrg(e.target.value)}
            className="w-full rounded border border-line bg-surface h-8 px-2 text-sm"
          >
            {memberships.map((m) => <option key={m.org_id} value={m.org_id}>{m.organizations.name}</option>)}
          </select>
        ) : (
          <p className="truncate text-sm font-medium" title={orgName}>{orgName}</p>
        )}
      </div>
      <div className="flex-1 overflow-y-auto"><NavList onNavigate={() => setOpen(false)} /></div>
      <div className="space-y-1 border-t border-line pt-3">
        <p className="truncate px-3 text-xs text-muted" title={user?.email ?? ''}>{user?.email}</p>
        <button onClick={toggle} className="flex w-full items-center gap-3 rounded px-3 h-9 text-sm text-muted hover:bg-sunken hover:text-ink">
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />} {dark ? 'Light mode' : 'Dark mode'}
        </button>
        <button onClick={signOut} className="flex w-full items-center gap-3 rounded px-3 h-9 text-sm text-muted hover:bg-sunken hover:text-ink">
          <LogOut className="h-4 w-4" /> Sign out
        </button>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="hidden border-r border-line bg-surface lg:block lg:sticky lg:top-0 lg:h-screen">{sidebar}</aside>

      <header className="sticky top-0 z-30 flex h-12 items-center justify-between border-b border-line bg-surface px-4 lg:hidden">
        <Logo />
        <button onClick={() => setOpen(true)} aria-label="Open menu" className="rounded p-2 text-muted hover:bg-sunken">
          <Menu className="h-5 w-5" />
        </button>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64 bg-surface shadow-xl">
            <button onClick={() => setOpen(false)} aria-label="Close menu" className="absolute right-2 top-2 rounded p-2 text-muted hover:bg-sunken">
              <X className="h-4 w-4" />
            </button>
            {sidebar}
          </div>
        </div>
      )}

      <main className="min-w-0 px-4 py-6 sm:px-8 lg:py-8">
        <div className="mx-auto max-w-5xl"><Outlet /></div>
      </main>
    </div>
  )
}
