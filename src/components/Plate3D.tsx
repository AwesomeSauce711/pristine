'use client';

import {
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ElementType,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { play } from '@/lib/sound';
import { subscribeMotion, type Motion } from '@/lib/stage-motion';

/*
 * A floating glass slab.
 *
 * Every panel of text on the landing page — the four measured numbers, the
 * three steps, the proof readout, the FAQ rows — is one of these: a `.plate`
 * group holding a `.plate-face` of smoked glass over a `.plate-edge` that is
 * the face's outline translated `depth` px back, in three graded layers, so
 * the slab has real thickness (the material is all in globals.css; this file
 * is the geometry and the motion). The thickness is seen the way thickness
 * is seen: the SceneSection's eye sits above the viewport's centre, so a slab
 * low on the screen shows its underside and flattens as it rises past the
 * eye, and a lean toward the pointer turns an edge into view.
 *
 * It does three things the flat panels did not:
 *
 * RISES IN. The first time it comes into view it fades and lifts into place
 * (`.fade-in-view` → `.is-in`, the `translate` property so it composes with
 * the lean below), `delay` ms after its neighbours, so a grid arrives as a
 * cascade rather than a wall. The hide happens only once an
 * IntersectionObserver is confirmed to exist — the rule Reveal and CountUp
 * follow: a crawler, a reader without JavaScript, or a browser without the
 * API sees the panel rather than nothing — and with transitions suspended
 * for that one style pass, so a plate already painted is hidden in place
 * rather than seen fading out.
 *
 * LEANS WITH THE PAGE. All plates read the same motion the phone reads
 * (src/lib/stage-motion.ts — the pointer across the whole viewport, or the
 * gyroscope on a phone) and lean toward it together, up to `tilt` degrees, so
 * the page turns as one surface. A pointer over a plate leans that plate
 * further, toward the pointer's side, and lights the spotlight that follows
 * it across the glass; the maths is Tilt's. Both are eased frame to frame,
 * and only `transform` is ever written.
 *
 * ONE CLOCK FOR EVERY PLATE. There is one subscription to the motion store and
 * one animation frame loop for all the plates on the page, not one per plate.
 * The loop runs only while something is still moving — a lean settling — and
 * skips plates that are off screen, so a resting page costs nothing per frame.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * No `backdrop-filter`, no `filter`, no `mask`. The plates sit inside the
 * SceneSection's 3D rendering context, and a grouping property on anything in
 * that context makes the browser flatten and re-rasterise the whole context
 * every frame (Holograms.tsx records what that cost the stage). The face is
 * opaque glass instead. The edge comes BEFORE the face in the DOM, so during
 * the fade — when the group's opacity flattens it for a moment — painting
 * order and depth order agree and nothing pops.
 *
 * WHERE `className` GOES
 * On the face — the padded content surface — so `p-7`, `px-6`, `min-h-*`
 * style the glass itself. The root is a grid whose only flow item is the
 * face, so the face fills the root and the edge (absolute, inset 0) always
 * matches it, including when a <details> inside opens. To make plates in a
 * grid share a height, place the root directly in the grid (or make the <li>
 * a grid): a grid item is stretched. Margins go on a wrapper.
 *
 * The edge and the glare are aria-hidden and take no pointer events; nothing
 * here is focusable, and the real controls inside (a <summary>, a link) keep
 * their own focus rings and keyboard behaviour.
 */

interface Props {
  children: ReactNode;
  /** Classes for the face (padding, min-height). Margins go on a wrapper. */
  className?: string;
  /** Thickness of the slab, px (`--plate-depth`). */
  depth?: number;
  /** Largest lean in degrees at the edge of the page; the hover lean is 1.5× this. */
  tilt?: number;
  /** Stagger for the rise-in, ms. */
  delay?: number;
  /** The iridescent ring (`.plate-glow`). */
  glow?: boolean;
  /** The root element. */
  as?: 'div' | 'li' | 'section' | 'article' | 'aside' | 'figure';
}

/* ------------------------------------------------------------ tuning */

/* Easing per 60 Hz frame, converted to a time constant in the loop so a
 * 120 Hz screen does not ease twice as fast. The global lean is slow — it is
 * the whole page turning; the local lean is quick, it is the reader's hand.
 * Under reduced motion the page still follows the pointer, at half the pace. */
const EASE_GLOBAL = 0.08;
const EASE_GLOBAL_STILL = 0.035;
const EASE_LOCAL = 0.12;
/* The hover lean, as a multiple of `tilt`, and the lift while hovered. */
/* No extra lean toward the pointer over the plate: hover shows as colour,
 * size and sound, not as the slab chasing the cursor. */
const LOCAL_GAIN = 0;
const HOVER_SCALE = 1.015;
/* A plate counts as visible this far outside the viewport, so it is already
 * leaning correctly when it scrolls in. */
const VIEW_MARGIN = '200px 0px';
/* The reveal fires when the plate is properly in the picture — a tenth of it
 * visible, clear of the bottom 8% — so the rise is seen, not already over. */
const REVEAL_MARGIN = '0px 0px -8% 0px';
const REVEAL_THRESHOLD = 0.1;

const clamp1 = (n: number) => Math.min(1, Math.max(-1, n));
const cx = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(' ');

/* ------------------------------------------------------------ the shared clock */

interface Entry {
  root: HTMLElement;
  face: HTMLElement;
  glare: HTMLElement | null;
  tilt: number;
  /** Stagger before the rise, ms. */
  delay: number;
  inView: boolean;
  hover: boolean;
  /** Where the pointer is over the plate, −1…1, and the eased lean and lift. */
  hx: number;
  hy: number;
  lx: number;
  ly: number;
  s: number;
  /** The last transform written, so a settled plate is never rewritten. */
  last: string;
}

const plates = new Set<Entry>();
const byElement = new WeakMap<Element, Entry>();
const timers = new Map<Entry, number>();
let raf = 0;
let last = 0;
/* The page's motion, and the eased lean every plate shares. */
let tx = 0;
let ty = 0;
let gx = 0;
let gy = 0;
let still: MediaQueryList | null = null;
let fine: MediaQueryList | null = null;
let unsubscribe: (() => void) | null = null;
let revealIO: IntersectionObserver | null = null;
let viewIO: IntersectionObserver | null = null;

function schedule() {
  if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
}

function frame(now: number) {
  raf = 0;
  const dt = last ? Math.min(48, now - last) : 16.7;
  last = now;
  const reduced = still?.matches ?? false;

  const kG = 1 - Math.pow(1 - (reduced ? EASE_GLOBAL_STILL : EASE_GLOBAL), dt / 16.7);
  gx += (tx - gx) * kG;
  gy += (ty - gy) * kG;
  let busy = Math.abs(tx - gx) > 0.001 || Math.abs(ty - gy) > 0.001;
  if (!busy) {
    gx = tx;
    gy = ty;
  }
  const kL = 1 - Math.pow(1 - EASE_LOCAL, dt / 16.7);

  for (const p of plates) {
    if (!p.inView) continue;

    const hx = p.hover ? p.hx : 0;
    const hy = p.hover ? p.hy : 0;
    const hs = p.hover ? HOVER_SCALE : 1;
    p.lx += (hx - p.lx) * kL;
    p.ly += (hy - p.ly) * kL;
    p.s += (hs - p.s) * kL;
    if (Math.abs(hx - p.lx) > 0.001 || Math.abs(hy - p.ly) > 0.001 || Math.abs(hs - p.s) > 0.0005) {
      busy = true;
    } else {
      p.lx = hx;
      p.ly = hy;
      p.s = hs;
    }

    // A pointer at the top lifts the top edge (negative rotateX brings it
    // forward); one at the right lifts the right edge (negative rotateY).
    const rx = gy * p.tilt + p.ly * p.tilt * LOCAL_GAIN;
    const ry = -(gx * p.tilt + p.lx * p.tilt * LOCAL_GAIN);
    const t = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(${p.s.toFixed(4)})`;
    if (t !== p.last) {
      p.last = t;
      p.root.style.transform = t;
    }
  }

  if (busy && !document.hidden) raf = requestAnimationFrame(frame);
  else last = 0;
}

function onMotion(m: Motion) {
  tx = m.x;
  ty = m.y;
  schedule();
}

function onVisibility() {
  if (document.hidden) {
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
  } else {
    schedule();
  }
}

function install() {
  if (typeof window.matchMedia === 'function') {
    still = window.matchMedia('(prefers-reduced-motion: reduce)');
    fine = window.matchMedia('(hover: hover) and (pointer: fine)');
  }
  if (typeof IntersectionObserver !== 'undefined') {
    /* Off screen a plate is not leaned: this keeps the loop honest. */
    viewIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const p = byElement.get(e.target);
          if (!p) continue;
          p.inView = e.isIntersecting;
          if (p.inView) schedule();
        }
      },
      { rootMargin: VIEW_MARGIN },
    );
    revealIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          revealIO?.unobserve(e.target);
          const p = byElement.get(e.target);
          if (p) reveal(p);
        }
      },
      { rootMargin: REVEAL_MARGIN, threshold: REVEAL_THRESHOLD },
    );
  }
  document.addEventListener('visibilitychange', onVisibility);
  unsubscribe = subscribeMotion(onMotion);
}

function uninstall() {
  unsubscribe?.();
  unsubscribe = null;
  document.removeEventListener('visibilitychange', onVisibility);
  viewIO?.disconnect();
  revealIO?.disconnect();
  viewIO = null;
  revealIO = null;
  cancelAnimationFrame(raf);
  raf = 0;
  last = 0;
  still = null;
  fine = null;
}

/*
 * Hide a plate that may already be on screen without it being seen to fade
 * out: transitions off for one style pass, the class added, the pass forced,
 * transitions handed back. The next change — `.is-in` — then transitions.
 */
function park(p: Entry) {
  const el = p.root;
  el.style.transition = 'none';
  el.classList.add('fade-in-view');
  void el.offsetWidth;
  el.style.transition = '';
}

function reveal(p: Entry) {
  const go = () => {
    timers.delete(p);
    p.root.classList.add('is-in');
  };
  if (p.delay > 0) timers.set(p, window.setTimeout(go, p.delay));
  else go();
}

function register(p: Entry) {
  plates.add(p);
  byElement.set(p.root, p);
  if (plates.size === 1) install();
  viewIO?.observe(p.root);
}

function unregister(p: Entry) {
  const timer = timers.get(p);
  if (timer) window.clearTimeout(timer);
  timers.delete(p);
  viewIO?.unobserve(p.root);
  revealIO?.unobserve(p.root);
  byElement.delete(p.root);
  plates.delete(p);
  if (plates.size === 0) uninstall();
}

/* ------------------------------------------------------------ the component */

export default function Plate3D({
  children,
  className,
  depth = 10,
  tilt = 2,
  delay = 0,
  glow = false,
  as = 'div',
}: Props) {
  const rootRef = useRef<HTMLElement>(null);
  const faceRef = useRef<HTMLDivElement>(null);
  const glareRef = useRef<HTMLDivElement>(null);
  const entry = useRef<Entry | null>(null);

  /*
   * A layout effect, so a plate mounted while it is already on screen — the
   * tool's paywall dialog — is parked before the browser paints it and rises
   * in cleanly rather than flashing at rest first. For server-rendered plates
   * the pre-hydration paint has already happened; on the landing page those
   * are all below the fold, so the park is never seen.
   */
  useLayoutEffect(() => {
    const root = rootRef.current;
    const face = faceRef.current;
    if (!root || !face) return;
    const p: Entry = {
      root,
      face,
      glare: glareRef.current,
      tilt: Math.max(0, tilt),
      delay: Math.max(0, delay),
      inView: true,
      hover: false,
      hx: 0,
      hy: 0,
      lx: 0,
      ly: 0,
      s: 1,
      last: '',
    };
    entry.current = p;
    register(p);

    /* Only now is it safe to hide the plate: we know we can show it again. */
    if (revealIO) {
      park(p);
      revealIO.observe(root);
    }

    return () => {
      unregister(p);
      entry.current = null;
      root.classList.remove('fade-in-view', 'is-in');
      root.style.transform = '';
      root.style.willChange = '';
      root.style.transition = '';
    };
  }, [tilt, delay]);

  const allowed = (e: ReactPointerEvent) =>
    fine !== null && fine.matches && e.pointerType !== 'touch';

  const onPointerEnter = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = entry.current;
    if (!p || !allowed(e)) return;
    play('hover');
    if (p.glare) p.glare.classList.add('is-on');
    if (still?.matches) return;
    p.hover = true;
    p.root.style.willChange = 'transform';
    schedule();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = entry.current;
    if (!p || !allowed(e)) return;
    // The centre survives the rotation (the transform origin is the centre)
    // but the bounding box does not: size from layout, position from the rect.
    const r = p.face.getBoundingClientRect();
    const w = p.face.offsetWidth || r.width;
    const h = p.face.offsetHeight || r.height;
    if (!w || !h) return;
    const px = clamp1(((e.clientX - (r.left + r.width / 2)) / w) * 2);
    const py = clamp1(((e.clientY - (r.top + r.height / 2)) / h) * 2);
    p.face.style.setProperty('--mx', `${((px + 1) * 50).toFixed(1)}%`);
    p.face.style.setProperty('--my', `${((py + 1) * 50).toFixed(1)}%`);
    if (!p.hover) return;
    p.hx = px;
    p.hy = py;
    schedule();
  };

  const onPointerLeave = () => {
    const p = entry.current;
    if (!p) return;
    if (p.glare) p.glare.classList.remove('is-on');
    if (!p.hover) return;
    p.hover = false;
    p.hx = 0;
    p.hy = 0;
    p.root.style.willChange = '';
    schedule();
  };

  const Root = as as ElementType;
  const rootStyle = {
    display: 'grid',
    '--plate-depth': `${Math.max(0, depth)}px`,
    '--fade-delay': `${Math.max(0, delay)}ms`,
  } as CSSProperties;

  return (
    <Root ref={rootRef} className="plate" style={rootStyle}>
      {/* The thickness — before the face, so painting order and depth agree. */}
      <div aria-hidden="true" className="plate-edge" />
      <div
        ref={faceRef}
        className={cx('plate-face', glow && 'plate-glow', className)}
        onPointerEnter={onPointerEnter}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        {children}
        {/* The spotlight under the pointer, while it is over the glass. */}
        <div ref={glareRef} aria-hidden="true" className="plate-glare" />
      </div>
    </Root>
  );
}
