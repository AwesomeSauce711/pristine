'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import NavCta from '@/components/NavCta';
import SoundToggle from '@/components/SoundToggle';
import Wordmark from '@/components/Wordmark';
import { play, soundProps } from '@/lib/sound';
import { subscribeMotion } from '@/lib/stage-motion';

/*
 * The navigation, as scenery.
 *
 * There is no header bar. The brief for this round was "the logo, name and
 * buttons are part of the scenery — one big page", so what used to be a
 * sticky, blurred strip across the top of every page is now two things:
 *
 * 1. THE FLOATING CLUSTER — the wordmark top-left and the two links plus the
 *    CTA top-right, absolutely positioned inside the page's first section and
 *    held a little in front of it. Each sits at its own depth in a shared
 *    `perspective: 1400px` (the stage's eye, so "40px nearer" means the same
 *    thing here and there) and slides a few pixels against the reader's
 *    pointer, nearer ones further, so they read as things hanging in the scene
 *    rather than printed on it. Nothing else changes: the same three link
 *    texts, the same <Link>s in the same DOM order, the same focus rings, and
 *    a `<header>` landmark for the skip link to skip.
 *
 * 2. THE DOCK — bottom-right, fixed, a glass pill holding the CTA again, the
 *    sound toggle and a back-to-top button. On the landing page it arrives once
 *    the reader has scrolled the hero away (an IntersectionObserver on a
 *    viewport-tall sentinel at the top of the section): until then the hero's
 *    own buttons are in view and a dock over them is clutter. On the app page
 *    it is there from the start: that page can be shorter than a viewport
 *    before a file is dropped, the tool plays sounds from that first drop, and
 *    the sound toggle lives only here — a mute the reader cannot reach is not
 *    a mute. `inert` while hidden, so it never catches a Tab.
 *
 * WHY THE PARALLAX SLIDES AGAINST THE POINTER
 * Two metaphors run through the scene and both are kept coherent. Things the
 * reader holds — the phone, the plates — turn toward the pointer. Things the
 * reader is among — the hero field, and these — slide the other way as the eye
 * moves, nearer ones more: HeroField eases its camera toward the pointer, and
 * this does the same by hand. The reading comes from stage-motion, so the
 * gyroscope drives it on a phone exactly as the mouse does on a desktop.
 *
 * WHY EACH ELEMENT CARRIES A COUNTER-TRANSLATE
 * A shared perspective projects everything away from its centre: an element
 * 48px nearer that sits 900px left of the origin lands some 32px further left,
 * which on a wide screen is off the page. So each element is first translated
 * by −(offset from the origin) × depth / 1400, which puts its projected centre
 * back exactly where layout had it (the projection scales offsets by
 * 1400 / (1400 − z); on a pre-projection translate this is its inverse).
 * Measured with a ResizeObserver, so a font swap, the CTA changing from
 * "Try free" to "Account", or a resize re-seats them.
 *
 * WHY THE TEXT IS COUNTER-SCALED
 * A layer 48px in front of the page is projected 3.5% larger, and the
 * compositor rasterises it at 1× and magnifies, which softens type — exactly
 * the kind of cheap-looking edge this round is meant to remove. Each element
 * is scaled by (1400 − z) / 1400 so it is drawn and shown at 1:1; its depth
 * shows in how it moves, not in a blurrier wordmark. `CRISP` below turns this
 * off if the size cue is ever wanted more than the crispness.
 *
 * WHY THE ENTRANCE FADES THE WHOLE LAYER
 * Opacity below 1 flattens an element's 3D children, so fading the two
 * clusters in separately would show the elements without their depth for
 * 700ms and then pop them into it. The header — the flat root of this context
 * — rises as one instead, with the same `.rise` the hero copy uses.
 *
 * PERFORMANCE
 * Transform only, one write per animation frame, eased 0.1/frame and stopped
 * as soon as it settles; four small compositor layers with `will-change`,
 * released on unmount. Nothing of this file's own inside the 3D context
 * carries a filter, mask or backdrop-filter, and the context holds no video —
 * the CTA's 1px ring mask (NavCta's `.pill-primary::after`, unchanged) is
 * static and repaints nothing per frame. The dock sits outside every 3D
 * context; its glass is `.dock` in globals.css.
 */

interface Props {
  /**
   * `landing` gates the dock on the first viewport and uses the hero's column;
   * `app` keeps the dock present from the start, uses the tool's column and
   * calms the parallax.
   */
  variant?: 'landing' | 'app';
}

/* ---------------------------------------------------------------- tuning */

/* The eye, in px. The same 1400 the stage, the plates and the hero field use. */
const PERSPECTIVE = 1400;

/* How far in front of the page each element floats, in px. The wordmark is
 * nearest — it is the brand — and the two links furthest. */
const DEPTH = { wordmark: 48, cta: 36, link: 22 } as const;
const DEPTH_MAX = DEPTH.wordmark;

/* The parallax: how far the nearest element slides when the reader is at the
 * page's edge, in px, and the vertical travel as a fraction of that. The app
 * page is calmer — the reader is working there, not looking around. */
const PARALLAX_PX: Record<'landing' | 'app', number> = { landing: 2, app: 1.5 };
const PARALLAX_Y = 0.6;

/* Draw each element at 1:1 despite its depth (see WHY THE TEXT IS COUNTER-SCALED). */
const CRISP = true;

/* The ease per frame toward the reading; slower under reduced motion, where a
 * pointer-following tilt is allowed but drift is not. Below SETTLED the loop
 * stops and waits for the next reading. */
const EASE = 0.1;
const EASE_STILL = 0.05;
const SETTLED = 0.002;

/* The dock's entrance, and how long after mount it arrives on the app page
 * (after the page's own rise, so two things do not arrive at once). */
const DOCK_MS = 400;
const APP_DOCK_DELAY_MS = 700;

/* ------------------------------------------------------------- helpers */

const STILL_QUERY = '(prefers-reduced-motion: reduce)';

const canMatchMedia = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

function subscribeStill(onChange: () => void) {
  if (!canMatchMedia()) return () => {};
  const mq = window.matchMedia(STILL_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
const getStill = () => canMatchMedia() && window.matchMedia(STILL_QUERY).matches;
const getStillOnServer = () => false;

/** The reduced-motion preference, as render state, without a mismatch on hydration. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeStill, getStill, getStillOnServer);
}

/* ----------------------------------------------------------- component */

export default function SceneNav({ variant = 'landing' }: Props) {
  const layerRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const homeRef = useRef<HTMLAnchorElement>(null);
  const [dockShown, setDockShown] = useState(false);
  const still = useReducedMotion();

  /*
   * The parallax. Every element with a `data-depth` is placed at that depth,
   * seated back where layout put it, and slid against the reading. One rAF
   * loop, started by a reading and stopped when settled.
   */
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !canMatchMedia()) return;
    const items = Array.from(layer.querySelectorAll<HTMLElement>('[data-depth]'));
    if (items.length === 0) return;
    const stillList = window.matchMedia(STILL_QUERY);
    const amp = PARALLAX_PX[variant];

    const depth = items.map((el) => Number(el.dataset.depth) || 0);
    /* The scale that draws each element at 1:1, and the x that seats it. */
    const scale = depth.map((z) => (CRISP ? (PERSPECTIVE - z) / PERSPECTIVE : 1));
    const home = new Array<number>(items.length).fill(0);

    let raf = 0;
    let tx = 0;
    let ty = 0;
    let cx = 0;
    let cy = 0;

    const apply = () => {
      for (let i = 0; i < items.length; i++) {
        const k = depth[i] / DEPTH_MAX;
        const x = home[i] - cx * amp * k;
        const y = -cy * amp * PARALLAX_Y * k;
        items[i].style.transform =
          `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, ${depth[i]}px) scale(${scale[i].toFixed(4)})`;
      }
    };
    const measure = () => {
      /* The perspective origin is the layer's centre; offsets are layout
       * values, so the elements' own transforms never feed back into this. */
      const origin = layer.offsetWidth / 2;
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        const centre = el.offsetLeft + el.offsetWidth / 2;
        home[i] = -(centre - origin) * (depth[i] / PERSPECTIVE);
      }
      apply();
    };
    const paint = () => {
      raf = 0;
      const k = stillList.matches ? EASE_STILL : EASE;
      cx += (tx - cx) * k;
      cy += (ty - cy) * k;
      apply();
      if (Math.abs(tx - cx) > SETTLED || Math.abs(ty - cy) > SETTLED) raf = requestAnimationFrame(paint);
    };
    const schedule = () => {
      if (!raf && !document.hidden) raf = requestAnimationFrame(paint);
    };

    for (const el of items) el.style.willChange = 'transform';
    measure();
    const unsubscribe = subscribeMotion((m) => {
      tx = m.x;
      ty = m.y;
      schedule();
    });

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(layer);
      for (const el of items) ro.observe(el);
    } else {
      window.addEventListener('resize', measure);
    }
    /* Coming back to the tab resumes an ease that was left unfinished. */
    document.addEventListener('visibilitychange', schedule);

    return () => {
      unsubscribe();
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      document.removeEventListener('visibilitychange', schedule);
      cancelAnimationFrame(raf);
      for (const el of items) {
        el.style.transform = '';
        el.style.willChange = '';
      }
    };
  }, [variant]);

  /* The dock's arrival: gated on the sentinel on the landing page, timed on the app page. */
  useEffect(() => {
    if (variant === 'app') {
      const id = window.setTimeout(() => setDockShown(true), APP_DOCK_DELAY_MS);
      return () => window.clearTimeout(id);
    }
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    if (typeof IntersectionObserver === 'undefined') {
      /* No observer: the scroll position says the same thing, less cheaply. */
      const onScroll = () => setDockShown(window.scrollY > window.innerHeight);
      window.addEventListener('scroll', onScroll, { passive: true });
      return () => window.removeEventListener('scroll', onScroll);
    }
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last) setDockShown(!last.isIntersecting);
      },
      { threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [variant]);

  /*
   * Back to the top. `scrollTo` with no behaviour follows the root's
   * `scroll-behavior` — smooth here, instant under reduced motion — and focus
   * goes to the first thing on the page without a second scroll. A mouse click
   * leaves no ring behind (`:focus-visible` carries over only from keyboard
   * focus); a keyboard press lands the ring on the wordmark, which is right.
   */
  const toTop = useCallback(() => {
    play('whoosh');
    window.scrollTo({ top: 0 });
    homeRef.current?.focus({ preventScroll: true });
  }, []);

  const column = variant === 'landing' ? 'max-w-7xl' : 'max-w-6xl';

  return (
    <>
      {/* The first viewport, as a thing the observer can watch leave. */}
      <div
        ref={sentinelRef}
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 h-svh w-px"
      />

      {/*
        * The floating cluster. The header is the flat root of the 3D context
        * and takes the entrance; the row and the two clusters preserve 3D so
        * the elements' depths are projected by the header's eye. Pointer
        * events are off on everything but the controls themselves, so a hero
        * headline under this band is never harder to select.
        */}
      <header
        ref={layerRef}
        data-variant={variant}
        className="rise pointer-events-none absolute inset-x-0 top-0 z-20"
        style={{ perspective: `${PERSPECTIVE}px` }}
      >
        <div
          className={`mx-auto flex ${column} items-center justify-between px-6 pt-5 md:pt-6`}
          style={{ transformStyle: 'preserve-3d' }}
        >
          <div style={{ transformStyle: 'preserve-3d' }}>
            <span data-depth={DEPTH.wordmark} className="pointer-events-auto inline-flex">
              <Link
                ref={homeRef}
                href="/"
                aria-label="Pristine home"
                className="inline-flex transition hover:opacity-90"
                {...soundProps('brand')}
              >
                <Wordmark />
              </Link>
            </span>
          </div>

          <nav className="flex items-center gap-1 sm:gap-2" style={{ transformStyle: 'preserve-3d' }}>
            <span data-depth={DEPTH.link} className="pointer-events-auto hidden sm:inline-flex">
              <Link href="/#how" className="nav-link" {...soundProps('hover')}>
                How to use it
              </Link>
            </span>
            <span data-depth={DEPTH.link} className="pointer-events-auto hidden sm:inline-flex">
              <Link href="/#pricing" className="nav-link" {...soundProps('hover')}>
                Pricing
              </Link>
            </span>
            <span data-depth={DEPTH.cta} className="pointer-events-auto inline-flex" {...soundProps('hover')}>
              <NavCta />
            </span>
          </nav>
        </div>
      </header>

      {/*
        * The dock. Outside the 3D context, above the page, under the dev bar.
        * Hidden it is transparent, a little low, and inert — out of the tab
        * order and out of the accessibility tree — so its CTA cannot be reached
        * twice while the one in the cluster is on screen. The offsets keep it
        * clear of a phone's home indicator.
        */}
      <div
        className="dock fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-40 flex items-center gap-2"
        data-shown={dockShown}
        inert={!dockShown}
        style={{
          opacity: dockShown ? 1 : 0,
          transform: dockShown || still ? 'none' : 'translateY(12px)',
          transition: still
            ? `opacity ${DOCK_MS}ms ease`
            : `opacity ${DOCK_MS}ms ease, transform ${DOCK_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        }}
      >
        <span className="inline-flex" {...soundProps('hover')}>
          <NavCta />
        </span>
        <SoundToggle />
        {/* Icon-only, so the label is the one new string this file adds. It
            is built exactly as the sound toggle is — the same `.sound-toggle`
            glass and the same 40px round layout — so the two read as a pair;
            `dock-top` is a hook for anything it should do differently. */}
        <button
          type="button"
          className="sound-toggle dock-top inline-grid h-11 w-11 place-items-center rounded-full pointer-fine:h-10 pointer-fine:w-10"
          aria-label="Back to top"
          onClick={toTop}
          {...soundProps('hover')}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false" width="18" height="18">
            <path
              d="M10 15.5v-11M4.75 9.75 10 4.5l5.25 5.25"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </>
  );
}
