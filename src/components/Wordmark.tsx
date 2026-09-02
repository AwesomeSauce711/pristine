/*
 * The wordmark, in three sizes.
 *
 * `nav` is the mark and the word, for the header of every page. `inline` is the
 * same pair sized in em, for the rare place it sits inside a line of copy.
 * `giant` is the word alone at page width, for the strip above the footer.
 *
 * The word is `.brand` — the iridescent sweep in globals.css — and the mark is
 * the frame-with-its-corners glyph the site has always had, now set in a dark
 * tile with a slowly turning iridescent rim (`.mark`, CSS only: a rotating
 * conic gradient behind an inset tile, so the nav costs nothing per frame).
 * The glyph stays white: the rim is the colour, the glyph is the shape.
 *
 * No `'use client'` and no hooks, so it renders inside the server-rendered nav
 * and inside the static landing page alike. The giant version is still — a
 * gradient the width of the viewport is not worth moving at a quarter opacity.
 */

interface Props {
  size?: 'nav' | 'inline' | 'giant';
  className?: string;
}

const cx = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(' ');

/** A frame with its corners intact — "nothing lost" in one glyph. */
function Glyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 5.5V2.8A.8.8 0 0 1 2.8 2h2.7M10.5 2h2.7a.8.8 0 0 1 .8.8v2.7M14 10.5v2.7a.8.8 0 0 1-.8.8h-2.7M5.5 14H2.8a.8.8 0 0 1-.8-.8v-2.7"
        stroke="white"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function Wordmark({ size = 'nav', className }: Props) {
  if (size === 'giant') {
    return <span className={cx('brand-static wordmark-giant', className)}>Pristine</span>;
  }
  return (
    <span className={cx('wordmark', size === 'nav' ? 'wordmark-nav' : 'wordmark-inline', className)}>
      <span className="mark" aria-hidden="true">
        <Glyph />
      </span>
      <span className="brand wordmark-word">Pristine</span>
    </span>
  );
}

/** The name, iridescent, for use inside a line of copy. */
export function Brand({
  children = 'Pristine',
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <span className={cx('brand', className)}>{children}</span>;
}
