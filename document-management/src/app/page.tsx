import Link from "next/link";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { DemoWorkspace } from "@/components/marketing/demo-workspace";
import { Hero } from "@/components/marketing/hero";

export default function HomePage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="hero-gradient">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6" aria-label="Main">
          <Brand light />
          <Button asChild variant="outline" size="sm" className="border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white">
            <Link href="/app">Open workspace</Link>
          </Button>
        </nav>
      </div>
      <main className="flex-1">
        <Hero />
        <div className="relative z-10 mx-auto -mt-16 max-w-7xl px-3 pb-16 sm:-mt-20 sm:px-6">
          <DemoWorkspace />
        </div>
      </main>
      <footer className="border-t bg-card py-6 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} Aurum Ventura Enterprise LLC · Business Administrative Services
      </footer>
    </div>
  );
}
