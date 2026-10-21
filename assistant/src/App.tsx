import { lazy, Suspense, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { envStatus } from '@/lib/supabase'
import { AuthProvider, useAuth } from '@/features/auth/AuthProvider'
import { AuthPage } from '@/features/auth/AuthPage'
import { OrgProvider } from '@/features/org/OrgProvider'
import { Onboarding } from '@/features/org/Onboarding'
import { AppShell } from '@/components/AppShell'
import { Spinner } from '@/components/ui'
import { SetupRequired } from '@/pages/SetupRequired'
import { AcceptInvite } from '@/features/team/AcceptInvite'
import { getPendingInvite } from '@/features/team/pendingInvite'

const Overview = lazy(() => import('@/pages/OverviewPage'))
const Assistant = lazy(() => import('@/pages/AssistantPage'))
const Tasks = lazy(() => import('@/pages/TasksPage'))
const Calendar = lazy(() => import('@/pages/CalendarPage'))
const Email = lazy(() => import('@/pages/EmailPage'))
const Documents = lazy(() => import('@/pages/DocumentsPage'))
const Workflows = lazy(() => import('@/pages/WorkflowsPage'))
const Activity = lazy(() => import('@/pages/ActivityPage'))
const Integrations = lazy(() => import('@/pages/IntegrationsPage'))
const Settings = lazy(() => import('@/pages/SettingsPage'))
const Usage = lazy(() => import('@/pages/UsagePage'))

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true } },
})

function Gate() {
  const { user, loading } = useAuth()
  const [invite, setInvite] = useState(getPendingInvite) // set by captureInviteFromUrl() at startup
  if (loading) return <Spinner />
  if (!user) return <AuthPage invited={!!invite} />
  if (invite) return <AcceptInvite token={invite} onDone={() => setInvite(null)} />
  return (
    <OrgProvider empty={<Onboarding />}>
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Overview />} />
            <Route path="assistant" element={<Assistant />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="email" element={<Email />} />
            <Route path="documents" element={<Documents />} />
            <Route path="workflows" element={<Workflows />} />
            <Route path="activity" element={<Activity />} />
            <Route path="integrations" element={<Integrations />} />
            <Route path="settings" element={<Settings />} />
            <Route path="settings/usage" element={<Usage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </OrgProvider>
  )
}

export default function App() {
  if (!envStatus.ok) return <SetupRequired missing={envStatus.missing} />
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}
