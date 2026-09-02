'use client';

import { useEffect, useRef, useState } from 'react';

/*
 * A decorative bar that draws itself in — scaleX 0 → 1 from the left — the
 * first time it comes into view. The hairline above each measured number and
 * the proportion bars in the proof readout are this.
 *
 * Same contract as Reveal, for the same reason: it starts fully drawn and only
 * collapses once the observer is confirmed to work, so a crawler, a reader
 * without JavaScript, or a browser without IntersectionObserver sees the bar
 * rather than nothing. Under reduced motion it never collapses at all — the
 * proportion a bar shows is the point; the drawing-in is not.
 *
 * `transform` only, so the browser animates it on the compositor and the
 * layout around it never moves. It renders an empty, aria-hidden div: it
 * carries no text and is never read out.
 */
export default function GrowIn({
  className,
  style,
  delay = 0,
  duration = 1100,
}: {
  className?: string;
  style?: React.CSSProperties;
  delay?: number;
  duration?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(true);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const el = ref.current;
    if (!el) return;

    // Only now is it safe to collapse: we know we can draw it again.
    setArmed(true);
    setShown(false);

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className={className}
      style={{
        ...style,
        transform: shown ? 'scaleX(1)' : 'scaleX(0)',
        transformOrigin: 'left center',
        transition: armed
          ? `transform ${duration}ms cubic-bezier(0.22,1,0.36,1) ${delay}ms`
          : undefined,
      }}
    />
  );
}
