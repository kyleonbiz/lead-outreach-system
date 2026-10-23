import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

export function Brand({ className, href = "/", light }: { className?: string; href?: string; light?: boolean }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}>
      <span className="flex size-9 items-center justify-center overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-black/5">
        <Image src="/logo-mark.png" alt="" width={152} height={114} className="h-7 w-auto" priority />
      </span>
      <span className="leading-tight">
        <span className={cn("block text-sm font-semibold tracking-tight", light && "text-white")}>Aurum Ventura</span>
        <span className={cn("block text-[11px]", light ? "text-white/70" : "text-muted-foreground")}>Document Management</span>
      </span>
    </Link>
  );
}
