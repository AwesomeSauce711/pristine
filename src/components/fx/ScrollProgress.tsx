'use client';

import { useEffect, useRef } from 'react';

/*
 * A 2px iridescent rail along the top of the viewport, filled as far as the
 * reader has scrolled.
 *
 * `transform: scaleX(progress)` from the left, never `width`: the transform
 * lives on the compositor, so tracking the scroll costs no layout and no
 * paint. Scroll and resize events fold into one write per animation frame,
 * and nothing runs while the tab is hidden.
 *
 * Fixed at z-index 60, above the sticky nav. The nav is blurred with
 * `backdrop-filter`, which makes it the containing block for any fixed
 * descendant — so mounted inside the nav the rail lands on the nav's top edge,
 * which is the viewport's top edge whenever the nav is stuck. It works from
 * inside the header and from the page root alike.
 *
 * Colours come from the theme's --color-iri-* tokens with literal fallbacks,
 * so the rail is right even if the stylesheet has not defined them yet.
 */

export default function ScrollProgress({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let raf = 0;
    const paint = () => {
      raf = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      el.style.transform = `scaleX(${p.toFixed(4)})`;
    };
    const schedule = () => {
      if (!raf && !document.hidden) raf = requestAnimationFrame(paint);
    };

    paint();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', schedule);
    // The page grows as videos and images size themselves. `resize` does not
    // fire for that, but the document element's box changes.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(document.documentElement);

    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', schedule);
      ro?.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={className}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        zIndex: 60,
        pointerEvents: 'none',
        transformOrigin: 'left',
        transform: 'scaleX(0)',
        willChange: 'transform',
        backgroundImage:
          'linear-gradient(90deg, var(--color-iri-pink, #ff6ad5), var(--color-iri-violet, #b06bff) 28%, ' +
          'var(--color-iri-blue, #5b8cff) 56%, var(--color-iri-cyan, #4ef0ff) 84%, #ffffff)',
        boxShadow: '0 0 8px rgba(91, 140, 255, 0.35)',
      }}
    />
  );
}
