'use client';

import { useEffect, useRef } from 'react';

/*
 * Moves its children a little slower than the page.
 *
 * The offset is `(element centre − viewport centre) × speed`: zero when the
 * element is centred, so it sits exactly where layout put it at the moment
 * the reader is looking straight at it, and lags behind the page on the way
 * in and out. Transform only, one write per animation frame, and the resting
 * position is recovered from the live rect (which includes our own
 * translation) rather than cached, so a layout change under the element
 * cannot leave it stranded.
 *
 * Under reduced motion the wrapper does nothing at all.
 */

interface Props {
  children: React.ReactNode;
  /** Fraction of the distance from the viewport centre to lag by. */
  speed?: number;
  className?: string;
}

export default function Parallax({ children, speed = 0.18, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window.matchMedia !== 'function') return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (still.matches) return;

    let raf = 0;
    let y = 0;
    const paint = () => {
      raf = 0;
      // Read live, so a preference changed mid-visit is honoured.
      if (still.matches) {
        y = 0;
        el.style.transform = '';
        return;
      }
      const r = el.getBoundingClientRect();
      const mid = r.top + r.height / 2 - y;
      y = (mid - window.innerHeight / 2) * speed;
      el.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
    };
    const schedule = () => {
      if (!raf && !document.hidden) raf = requestAnimationFrame(paint);
    };

    el.style.willChange = 'transform';
    paint();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', schedule);

    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', schedule);
      cancelAnimationFrame(raf);
      el.style.transform = '';
      el.style.willChange = '';
    };
  }, [speed]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
