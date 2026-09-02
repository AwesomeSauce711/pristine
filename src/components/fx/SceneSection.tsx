'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/*
 * A section of the page that is a space rather than a surface.
 *
 * `.scene` (globals.css) sets `perspective: 1400px` — the same eye as the
 * comparison stage and the WebGL hand, so a plate leaning in the FAQ and the
 * phone leaning in the hero are seen from one place — and `transform-style:
 * preserve-3d`, so the Plate3D slabs inside share that eye instead of each
 * projecting through a perspective of its own. Every wrapper between this
 * section and a plate must carry `[transform-style:preserve-3d]` too, or the
 * chain flattens there and the plate quietly falls back to a parallel
 * projection. It is one class per wrapper in page.tsx; there is no way to do
 * it from here.
 *
 * `overflow-x: clip`, not `hidden`: `hidden` is a grouping property that
 * would flatten the 3D context this element exists to create, while `clip`
 * is not — and it still stops a leaning plate or a hologram widening the page.
 *
 * THE EYE MOVES WITH THE READER
 * The perspective origin follows the viewport down the section, held a
 * little above the viewport's centre — the same "seen from slightly above"
 * the phone's 9° rest lean gives the stage. That is what makes a slab a slab:
 * one low on the screen shows its underside (its edge layers project below
 * its face) and flattens as it rises past the eye, with nothing but the
 * scroll driving it. Under reduced motion the eye stays at the section's
 * centre and the slabs simply are where they are.
 *
 * DEPTH ON SCROLL
 * Children with a `data-depth` attribute are translated by (section centre −
 * viewport centre) × depth as the reader scrolls, so a heading at 0.05 and a
 * decoration at 0.14 drift past at different speeds and the section reads as
 * layers at different distances. Zero when the section is centred, so each
 * layer sits exactly where layout put it at the moment the reader is looking
 * straight at it (Parallax's rule). Transform only, one write per animation
 * frame, and only while the section is within 200px of the viewport.
 *
 * `is-in` is added to the section the first time it comes into view, as a
 * hook for stylesheet-driven entrances. The plates inside reveal themselves
 * on their own observers, so a cascade can stagger; nothing here touches them.
 */

interface Props {
  children: ReactNode;
  className?: string;
  id?: string;
}

/* How far outside the viewport the section still updates, so nothing pops. */
const VIEW_MARGIN = '200px 0px';
/* The eye, as a fraction of the viewport height above its centre. At 0.35
 * the eye sits in the top sixth of the screen: a slab entering from the
 * bottom is ~700px below it and shows a clear underside (5px of edge at the
 * default depth); one about to leave at the top is seen nearly square on.
 * Higher shows more edge but skews a leaning slab low on the screen. */
const EYE_LIFT = 0.35;

const cx = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(' ');

export default function SceneSection({ children, className, id }: Props) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window.matchMedia !== 'function') return;
    // Read live, so a preference changed mid-visit is honoured.
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');

    /*
     * Only this section's own layers. SceneNav and the stage carry
     * `data-depth` too, with their own meaning, inside perspectives of their
     * own; a layer under a nested perspective belongs to that perspective.
     */
    const ownLayer = (l: HTMLElement) => {
      for (let a = l.parentElement; a && a !== el; a = a.parentElement) {
        if (getComputedStyle(a).perspective !== 'none') return false;
      }
      return true;
    };
    const layers = Array.from(el.querySelectorAll<HTMLElement>('[data-depth]')).filter(ownLayer);
    const depths = layers.map((l) => {
      const d = Number(l.dataset.depth);
      return Number.isFinite(d) ? d : 0;
    });
    // A moving wrapper must keep the 3D chain intact for the plates inside it.
    for (const l of layers) l.style.transformStyle = 'preserve-3d';

    let raf = 0;
    let inView = false;
    let painted = false;

    const rest = () => {
      if (!painted) return;
      painted = false;
      for (const l of layers) l.style.transform = '';
      el.style.perspectiveOrigin = '';
    };

    const paint = () => {
      raf = 0;
      if (still.matches) {
        rest();
        return;
      }
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const off = r.top + r.height / 2 - vh / 2;
      layers.forEach((l, i) => {
        l.style.transform = `translate3d(0, ${(off * depths[i]).toFixed(2)}px, 0)`;
      });
      // The eye, in the section's own coordinates.
      const eye = vh * (0.5 - EYE_LIFT) - r.top;
      el.style.perspectiveOrigin = `50% ${eye.toFixed(1)}px`;
      painted = true;
    };
    const schedule = () => {
      if (!raf && inView && !document.hidden) raf = requestAnimationFrame(paint);
    };

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          inView = entries.some((e) => e.isIntersecting);
          if (inView) {
            el.classList.add('is-in');
            for (const l of layers) l.style.willChange = 'transform';
            schedule();
          } else {
            for (const l of layers) l.style.willChange = '';
          }
        },
        { rootMargin: VIEW_MARGIN },
      );
      io.observe(el);
    } else {
      inView = true;
      schedule();
    }

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', schedule);
    return () => {
      io?.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', schedule);
      cancelAnimationFrame(raf);
      rest();
      for (const l of layers) {
        l.style.willChange = '';
        l.style.transformStyle = '';
      }
    };
  }, []);

  return (
    <section ref={ref} id={id} className={cx('scene relative', className)}>
      {children}
    </section>
  );
}
