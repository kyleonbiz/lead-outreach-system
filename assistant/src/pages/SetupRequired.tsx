import { Logo } from '@/components/Logo'
import { Notice } from '@/components/ui'

export function SetupRequired({ missing }: { missing: string[] }) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-lg space-y-5">
        <Logo />
        <h1 className="text-xl font-semibold tracking-tight">Connect your Supabase project</h1>
        <Notice tone="warn" title="Configuration required">
          Missing or invalid: <code className="font-mono">{missing.join(', ')}</code>
        </Notice>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted">
          <li>Copy <code className="font-mono">.env.example</code> to <code className="font-mono">.env.local</code>.</li>
          <li>Fill in the project URL and anon key from Supabase → Project Settings → API.</li>
          <li>Apply the migrations in <code className="font-mono">supabase/migrations</code>.</li>
          <li>Restart <code className="font-mono">npm run dev</code>.</li>
        </ol>
        <p className="text-sm text-muted">See <code className="font-mono">docs/SETUP.md</code> for the full walkthrough.</p>
      </div>
    </main>
  )
}
