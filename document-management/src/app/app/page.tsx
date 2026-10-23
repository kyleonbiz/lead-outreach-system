import { Brand } from "@/components/brand";
import { LiveWorkspace } from "@/components/dms/live-workspace";

export default function AppPage() {
  return (
    <div className="min-h-dvh">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Brand href="/app" />
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-3 py-6 sm:px-6">
        <LiveWorkspace mode="dev" />
      </main>
    </div>
  );
}
