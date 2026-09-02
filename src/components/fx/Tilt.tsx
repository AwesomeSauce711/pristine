'use client';

import { useEffect, useRef } from 'react';
import { stillQuery } from '@/lib/scene-tier';

/*
 * A card that tilts toward the pointer, with a soft spotlight under it.
 *
 * The side under the pointer lifts toward the viewer, and a faint radial
 * highlight follows the pointer across the surface so the tilt reads as a
 * panel catching light rather than as a shape rotating. Everything is
 * `transform` on the wrapper, throttled to one write per animation frame; a
 * short CSS transition smooths pointer jitter and leaving springs the card
 * back over 400 ms.
 *
 * Off for coarse pointers — there is no hover to follow, and a card tilting
 * under a finger fights the scroll — and under reduced motion. The wrapper
 * never takes focus and adds nothing that intercepts pointer events, so the
 * real controls inside it work exactly as they did.
 *
 * `--mx` / `--my` (0–100%) are set on the wrapper too, so a stylesheet can
 * use the pointer position for a highlight of its own.
 */

interface Props {
  children: React.ReactNode;
  className?: string;
  /** Largest rotation on either axis, in degrees. */
  max?: number;
  /** Draw the spotlight under the pointer. */
  glare?: boolean;
  /** Scale while hovered. */
  scale?: number;
}

const SPRING = 'cubic-bezier(0.22, 1, 0.36, 1)';
/* An explicit identity rather than `none`, so the spring back interpolates
 * term by term instead of popping when the perspective term disappears. */
const REST = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale(1)';

const clamp = (n: number) => Math.min(1, Math.max(-1, n));

export default function Tilt({ children, className, max = 8, glare = true, scale = 1.015 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const glareRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const raf = useRef(0);
  const media = useRef<{ still: MediaQueryList; coarse: MediaQueryList } | null>(null);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    // Kept as live lists and read per event, so a preference changed while
    // the page is open is honoured without any listeners.
    media.current = {
      still: stillQuery(),
      coarse: window.matchMedia('(hover: none), (pointer: coarse)'),
    };
    return () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      media.current = null;
    };
  }, []);

  const allowed = (e: React.PointerEvent) => {
    const m = media.current;
    return m !== null && !m.still.matches && !m.coarse.matches && e.pointerType !== 'touch';
  };

  const paint = () => {
    raf.current = 0;
    const el = ref.current;
    const p = pointer.current;
    if (!el || !p) return;
    // The centre survives the rotation (the transform origin is the centre)
    // but the bounding box does not, so the size comes from layout, not the
    // rect, and the pointer's position is measured against the resting card.
    const r = el.getBoundingClientRect();
    const w = el.offsetWidth || r.width;
    const h = el.offsetHeight || r.height;
    if (!w || !h) return;
    const px = clamp(((p.x - (r.left + r.width / 2)) / w) * 2);
    const py = clamp(((p.y - (r.top + r.height / 2)) / h) * 2);
    // A pointer at the top lifts the top edge (negative rotateX brings it
    // forward); one at the right lifts the right edge (negative rotateY).
    el.style.transform =
      `perspective(1000px) rotateX(${(py * max).toFixed(2)}deg) ` +
      `rotateY(${(-px * max).toFixed(2)}deg) scale(${scale})`;
    el.style.setProperty('--mx', `${((px + 1) * 50).toFixed(1)}%`);
    el.style.setProperty('--my', `${((py + 1) * 50).toFixed(1)}%`);
  };

  const onPointerEnter = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!allowed(e)) return;
    const el = e.currentTarget;
    el.style.willChange = 'transform';
    el.style.transition = `transform 160ms ${SPRING}`;
    const g = glareRef.current;
    if (!g) return;
    /*
     * The spotlight must clip to the card's corners. It inherits the wrapper's
     * radius, which is right when the wrapper is the card; when the card is
     * the child instead, the child's corners are copied once here so a square
     * highlight never shows over a rounded panel.
     */
    const child = el.firstElementChild;
    if (getComputedStyle(el).borderTopLeftRadius === '0px' && child instanceof HTMLElement && child !== g) {
      const cs = getComputedStyle(child);
      g.style.borderRadius =
        `${cs.borderTopLeftRadius} ${cs.borderTopRightRadius} ` +
        `${cs.borderBottomRightRadius} ${cs.borderBottomLeftRadius}`;
    }
    g.style.opacity = '1';
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!allowed(e)) return;
    pointer.current = { x: e.clientX, y: e.clientY };
    if (!raf.current) raf.current = requestAnimationFrame(paint);
  };

  const onPointerLeave = (e: React.PointerEvent<HTMLDivElement>) => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    pointer.current = null;
    const el = e.currentTarget;
    const g = glareRef.current;
    if (g) g.style.opacity = '0';
    if (el.style.transform && el.style.transform !== REST) {
      el.style.transition = `transform 400ms ${SPRING}`;
      el.style.transform = REST;
      // will-change is dropped when this transition ends, below.
    } else {
      el.style.willChange = '';
    }
  };

  const onTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    // Only the wrapper's own spring back — not a hover transition bubbling up
    // from a button inside. Once settled, give the compositor layer back.
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
    if (pointer.current === null) e.currentTarget.style.willChange = '';
  };

  return (
    <div
      ref={ref}
      className={className}
      style={{ position: 'relative', transformStyle: 'preserve-3d' }}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onTransitionEnd={onTransitionEnd}
    >
      {children}
      {glare && (
        <div
          ref={glareRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300"
          style={{
            backgroundImage:
              'radial-gradient(260px circle at var(--mx, 50%) var(--my, 50%), ' +
              'rgba(255,255,255,0.10), rgba(255,255,255,0.035) 45%, rgba(255,255,255,0) 72%)',
          }}
        />
      )}
    </div>
  );
}
