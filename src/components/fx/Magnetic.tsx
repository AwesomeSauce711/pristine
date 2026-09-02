'use client';

import { useEffect, useRef } from 'react';

/*
 * A control that leans toward the pointer.
 *
 * The wrapper translates its child toward the pointer once it comes within
 * `radius` px of the child's box, lerped frame to frame, and springs back
 * when the pointer moves away. The pull fades in with proximity — zero at the
 * edge of the reach, `strength` × the pointer's offset from the centre once
 * the pointer is over the control — so nothing jumps at the boundary.
 *
 * The pointer is tracked on `window`, not on the child. The child stays the
 * real interactive element — a Link, a button — with its own hover, focus and
 * click; the wrapper adds no handlers, no focus stop and nothing that could
 * swallow an event. It only reads where the pointer is.
 *
 * Off for coarse pointers and under reduced motion: no hover, no lean.
 */

interface Props {
  children: React.ReactNode;
  /** How far the child follows the pointer, as a fraction of the offset. */
  strength?: number;
  /** How far outside the child's box the pull reaches, in px. */
  radius?: number;
  className?: string;
}

/* Smoothstep: zero pull at the edge of the reach, full pull over the control. */
const smooth = (u: number) => u * u * (3 - 2 * u);

export default function Magnetic({ children, strength = 0.35, radius = 90, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window.matchMedia !== 'function') return;
    // Read per event rather than once, so a preference changed mid-visit is
    // honoured without listeners.
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    const coarse = window.matchMedia('(hover: none), (pointer: coarse)');

    let raf = 0;
    let last = 0;
    // Where the child is, and where it is heading, in px from rest.
    let cx = 0;
    let cy = 0;
    let tx = 0;
    let ty = 0;
    // Whether the pointer is within reach.
    let active = false;
    let pointer: { x: number; y: number } | null = null;

    const frame = (now: number) => {
      raf = 0;
      const dt = last ? Math.min(48, now - last) : 16.7;
      last = now;
      // Rates are per 60 Hz frame and scaled to the real frame time, so a
      // 120 Hz display does not make the lean twice as stiff. Following is
      // quicker than letting go.
      const k = 1 - Math.pow(1 - (active ? 0.22 : 0.12), dt / 16.7);
      cx += (tx - cx) * k;
      cy += (ty - cy) * k;
      const settled = Math.abs(tx - cx) < 0.05 && Math.abs(ty - cy) < 0.05;
      if (settled) {
        cx = tx;
        cy = ty;
      }
      el.style.transform =
        cx === 0 && cy === 0 ? '' : `translate3d(${cx.toFixed(2)}px, ${cy.toFixed(2)}px, 0)`;
      if (!settled) {
        raf = requestAnimationFrame(frame);
      } else {
        last = 0;
        if (!active) el.style.willChange = '';
      }
    };
    const schedule = () => {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    };

    const release = () => {
      if (!active && tx === 0 && ty === 0) return;
      active = false;
      tx = 0;
      ty = 0;
      schedule();
    };

    const aim = () => {
      const p = pointer;
      if (!p) return;
      const r = el.getBoundingClientRect();
      // The rect includes our own translation; undo it to get the resting box.
      const left = r.left - cx;
      const top = r.top - cy;
      // Distance from the pointer to the resting box: zero when over it.
      const dx = Math.max(left - p.x, 0, p.x - (left + r.width));
      const dy = Math.max(top - p.y, 0, p.y - (top + r.height));
      const d = Math.hypot(dx, dy);
      if (r.width === 0 || d > radius) {
        release();
        return;
      }
      const pull = strength * smooth(radius > 0 ? 1 - d / radius : 1);
      active = true;
      tx = (p.x - (left + r.width / 2)) * pull;
      ty = (p.y - (top + r.height / 2)) * pull;
      el.style.willChange = 'transform';
      schedule();
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || still.matches || coarse.matches) {
        pointer = null;
        release();
        return;
      }
      pointer = { x: e.clientX, y: e.clientY };
      aim();
    };
    // Leaving the window: relatedTarget is null only at the document's edge.
    const onOut = (e: PointerEvent) => {
      if (e.relatedTarget !== null) return;
      pointer = null;
      release();
    };
    // Scrolling under a still pointer moves the box, not the pointer.
    const onScroll = () => {
      if (pointer) aim();
    };
    const onVisibility = () => {
      if (!document.hidden) return;
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
      cx = cy = tx = ty = 0;
      active = false;
      pointer = null;
      el.style.transform = '';
      el.style.willChange = '';
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerout', onOut);
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerout', onOut);
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAnimationFrame(raf);
      el.style.transform = '';
      el.style.willChange = '';
    };
  }, [strength, radius]);

  return (
    <span ref={ref} className={className} style={{ display: 'inline-block' }}>
      {children}
    </span>
  );
}
