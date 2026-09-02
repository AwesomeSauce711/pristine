import Link from 'next/link';
import NavCta from '@/components/NavCta';
import Wordmark from '@/components/Wordmark';
import ScrollProgress from '@/components/fx/ScrollProgress';

/*
 * The header, on every page.
 *
 * Sticky, translucent and blurred, so the starfield and the page slide under
 * it. Its bottom edge is a faint iridescent hairline rather than a border —
 * over a canvas a solid line reads as a shelf. The wordmark is the site's
 * iridescent one (see Wordmark.tsx); the links are set as equipment labels
 * with CSS (`.nav-link`), so their text is exactly what it always was.
 *
 * The scroll rail lives here: `backdrop-filter` makes this header the
 * containing block for a fixed descendant, which pins the rail to the header's
 * top edge — the viewport's top edge whenever the header is stuck.
 */
export default function Nav() {
  return (
    <header className="sticky top-0 z-50 bg-bg/55 backdrop-blur-xl">
      <ScrollProgress />
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
        <Link href="/" className="transition hover:opacity-90" aria-label="Pristine home">
          <Wordmark />
        </Link>

        <nav className="flex items-center gap-1 sm:gap-2">
          <Link href="/#how" className="nav-link hidden sm:inline-flex">
            How to use it
          </Link>
          <Link href="/#pricing" className="nav-link hidden sm:inline-flex">
            Pricing
          </Link>
          <NavCta />
        </nav>
      </div>
      <div aria-hidden className="iri-line opacity-25" />
    </header>
  );
}
