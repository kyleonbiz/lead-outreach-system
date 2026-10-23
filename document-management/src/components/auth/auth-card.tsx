import { Brand } from "@/components/brand";

export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="hero-gradient flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Brand light className="mb-6" />
      <main className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-float sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">{subtitle}</p>
        {children}
      </main>
    </div>
  );
}
