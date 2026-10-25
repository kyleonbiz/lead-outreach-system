import Link from "next/link";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { DemoWorkspace } from "@/components/marketing/demo-workspace";
import { Hero } from "@/components/marketing/hero";

export default function HomePage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="hero-gradient flex-1">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6" aria-label="Main">
          <Brand light />
          <Button asChild variant="outline" size="sm" className="border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white">
            <Link href="/app">Open workspace</Link>
          </Button>
        </nav>
        <main>
          <Hero />
          <div className="mx-auto max-w-7xl px-3 pb-16 sm:px-6">
            <div className="glass-frame rounded-[28px] p-2.5 sm:p-5">
              <DemoWorkspace />
            </div>
          </div>
        </main>
      </div>
      <footer className="border-t border-indigo-100 bg-white/60 py-6 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} Aurum Ventura Enterprise LLC · Business Administrative Services
      </footer>
    </div>
  );
}
