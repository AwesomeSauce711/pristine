import Link from 'next/link';
import NavCta from '@/components/NavCta';

/** The wordmark. Deliberately not a logo file — one less request, and it scales. */
function Mark() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="relative grid h-7 w-7 place-items-center rounded-[9px] bg-accent">
        {/* A frame with its corner intact — "nothing lost" in one glyph. */}
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M2 5.5V2.8A.8.8 0 0 1 2.8 2h2.7M10.5 2h2.7a.8.8 0 0 1 .8.8v2.7M14 10.5v2.7a.8.8 0 0 1-.8.8h-2.7M5.5 14H2.8a.8.8 0 0 1-.8-.8v-2.7"
            stroke="white"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-[-0.01em]">Pristine</span>
    </span>
  );
}

export default function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-line-soft bg-bg/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="transition hover:opacity-80" aria-label="Pristine home">
          <Mark />
        </Link>

        <nav className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/#how"
            className="hidden rounded-lg px-3 py-2 text-[14px] text-muted transition hover:text-text sm:block"
          >
            How to use it
          </Link>
          <Link
            href="/#pricing"
            className="hidden rounded-lg px-3 py-2 text-[14px] text-muted transition hover:text-text sm:block"
          >
            Pricing
          </Link>
          <NavCta />
        </nav>
      </div>
    </header>
  );
}
