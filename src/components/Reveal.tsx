'use client';

import { useEffect, useRef, useState } from 'react';

/*
 * Fades a section in the first time it comes near the viewport.
 *
 * Starts visible and only hides itself once the observer is confirmed to work,
 * so a browser without IntersectionObserver — or a crawler, or a reader with
 * JavaScript disabled — sees the content rather than a blank page. Animation is
 * a decoration; it must never be load-bearing for whether text exists.
 */
export default function Reveal({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(true);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const el = ref.current;
    if (!el) return;

    // Only now is it safe to hide: we know we can reveal it again.
    setArmed(true);
    setShown(false);

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'none' : 'translateY(16px)',
        transition: armed
          ? `opacity 700ms cubic-bezier(0.22,1,0.36,1) ${delay}ms, transform 700ms cubic-bezier(0.22,1,0.36,1) ${delay}ms`
          : undefined,
      }}
    >
      {children}
    </div>
  );
}
