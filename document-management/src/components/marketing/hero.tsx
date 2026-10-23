import { FolderTree, ScanSearch, Tags } from "lucide-react";

const FEATURES = [
  { label: "Folder & Tag Organization", Icon: FolderTree },
  { label: "File Metadata Tracking", Icon: Tags },
  { label: "Full-Text Search", Icon: ScanSearch },
];

export function Hero() {
  return (
    <section className="hero-gradient relative overflow-hidden text-white" aria-labelledby="hero-title">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.35)_1px,transparent_0)] [background-size:28px_28px] [mask-image:linear-gradient(to_bottom,black,transparent_85%)]"
      />
      <div className="relative mx-auto max-w-5xl px-4 pb-28 pt-16 text-center sm:px-6 sm:pb-36 sm:pt-24">
        <h1 id="hero-title" className="text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
          Document Management System
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base text-white/85 sm:text-lg">
          Store, organize, and manage all business documents securely in one place.
        </p>
        <ul className="mt-9 flex flex-wrap items-center justify-center gap-3" aria-label="Key features">
          {FEATURES.map(({ label, Icon }) => (
            <li
              key={label}
              className="flex items-center gap-2 rounded-full border border-white/25 bg-white/15 px-4 py-2 text-sm font-medium backdrop-blur-sm"
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
