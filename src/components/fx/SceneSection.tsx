'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { stillQuery } from '@/lib/scene-tier';

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

/*
 * One scroll listener and one animation frame for every section on the
 * page, not one of each per section (the landing mounts seven). A scroll
 * tick measures every section first and writes every section after, so
 * the frame forces layout once rather than once per section as reads and
 * writes interleave. A section's `measure` returns null when it has
 * nothing to paint — off screen, or holding still — and is then skipped.
 */
interface Painter<T = unknown> {
  measure(): T | null;
  apply(m: T): void;
}
const painters = new Set<Painter>();
let sharedRaf = 0;

function paintAll() {
  sharedRaf = 0;
  const jobs: [Painter, unknown][] = [];
  for (const p of painters) {
    const m = p.measure();
    if (m !== null) jobs.push([p, m]);
  }
  for (const [p, m] of jobs) p.apply(m);
}
function scheduleAll() {
  if (!sharedRaf && !document.hidden) sharedRaf = requestAnimationFrame(paintAll);
}
function listen(painter: Painter): () => void {
  if (painters.size === 0) {
    window.addEventListener('scroll', scheduleAll, { passive: true });
    window.addEventListener('resize', scheduleAll);
    document.addEventListener('visibilitychange', scheduleAll);
  }
  painters.add(painter);
  return () => {
    painters.delete(painter);
    if (painters.size > 0) return;
    window.removeEventListener('scroll', scheduleAll);
    window.removeEventListener('resize', scheduleAll);
    document.removeEventListener('visibilitychange', scheduleAll);
    cancelAnimationFrame(sharedRaf);
    sharedRaf = 0;
  };
}

export default function SceneSection({ children, className, id }: Props) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window.matchMedia !== 'function') return;
    // Read live, so a preference changed mid-visit is honoured.
    const still = stillQuery();

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

    let inView = false;
    let painted = false;

    const rest = () => {
      if (!painted) return;
      painted = false;
      for (const l of layers) l.style.transform = '';
      el.style.perspectiveOrigin = '';
    };

    /* The measure is the only layout read; `rest` writes, so a section that
       has just started holding still rests on the write pass. */
    const REST = Symbol('rest');
    const painter: Painter<{ off: number; eye: number } | typeof REST> = {
      measure: () => {
        if (!inView) return null;
        if (still.matches) return painted ? REST : null;
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight;
        return {
          off: r.top + r.height / 2 - vh / 2,
          // The eye, in the section's own coordinates.
          eye: vh * (0.5 - EYE_LIFT) - r.top,
        };
      },
      apply: (m) => {
        if (m === REST) {
          rest();
          return;
        }
        layers.forEach((l, i) => {
          l.style.transform = `translate3d(0, ${(m.off * depths[i]).toFixed(2)}px, 0)`;
        });
        el.style.perspectiveOrigin = `50% ${m.eye.toFixed(1)}px`;
        painted = true;
      },
    };
    const unlisten = listen(painter);

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          inView = entries.some((e) => e.isIntersecting);
          /* `is-off` while the section is out of view: the stylesheet pauses
             the looping decorations inside it (the pricing cards' orbs,
             sweeps and auras keep a dozen compositor layers animating for
             nobody otherwise). Entrances are keyed to `is-in` and untouched. */
          el.classList.toggle('is-off', !inView);
          if (inView) {
            el.classList.add('is-in');
            for (const l of layers) l.style.willChange = 'transform';
            scheduleAll();
          } else {
            for (const l of layers) l.style.willChange = '';
          }
        },
        { rootMargin: VIEW_MARGIN },
      );
      io.observe(el);
    } else {
      inView = true;
      scheduleAll();
    }

    return () => {
      io?.disconnect();
      unlisten();
      el.classList.remove('is-off');
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
