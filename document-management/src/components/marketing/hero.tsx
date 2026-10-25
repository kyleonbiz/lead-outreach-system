const FEATURES = ["Folder & Tag Organization", "File Metadata Tracking", "Full-Text Search"];

export function Hero() {
  return (
    <section className="relative text-white" aria-labelledby="hero-title">
      <div className="relative mx-auto max-w-4xl px-4 pb-10 pt-8 text-center sm:px-6 sm:pb-12 sm:pt-12">
        <h1 id="hero-title" className="text-3xl font-semibold tracking-tight sm:text-4xl lg:text-5xl">
          Document Management System
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-base text-white/90 sm:text-lg">
          Store, organize, and manage all business documents securely in one place.
        </p>
        <ul className="mt-7 flex flex-wrap items-center justify-center gap-3" aria-label="Key features">
          {FEATURES.map((label) => (
            <li
              key={label}
              className="rounded-full border border-white/30 bg-white/15 px-5 py-2 text-sm font-medium backdrop-blur-sm"
            >
              {label}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
