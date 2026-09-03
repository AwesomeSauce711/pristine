'use client';

import dynamic from 'next/dynamic';
import { stillQuery, useSceneLite } from '@/lib/scene-tier';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import EngagementBloom from '@/components/EngagementBloom';
import Holograms from '@/components/Holograms';
import Phone3D, { phoneBox, phoneHeight, screenRatio } from '@/components/Phone3D';
import { play } from '@/lib/sound';
import { gyroActive, gyroNeedsPermission, requestGyro, subscribeMotion, tiltFor, type Motion } from '@/lib/stage-motion';
import type { Engagement } from '@/lib/engagement';

/* The hand is three.js, and three never enters the server bundle or the first
 * paint: it arrives in its own chunk, on the client, once the stage is near. */
const HandScene = dynamic(() => import('@/components/three/HandScene'), { ssr: false });

/*
 * The stage: a phone in a hand, under one eye.
 *
 * Both pages stand their phone here — the landing page's comparison and the
 * tool's preview — so that one file owns the perspective, the tilt, the hand,
 * the holograms and the light, and the two can never drift apart. `children`
 * is the screen (and whatever its owner puts under it); `descriptors` are the
 * plates that float over its corners; `t` is how far the comparison has been
 * pushed toward Pristine, and it lights everything: the phone's ring and its
 * spill, the hand's point light, the holograms, the pool on the table.
 *
 * ONE EYE
 * The DOM phone, the DOM holograms and the WebGL hand are three separate
 * renderers, and they have to agree about where the viewer is or the fingers
 * slide off the bezel as the phone turns. The column has `perspective: 1400px`
 * with its origin at the phone's centre; the hand's camera sits 1400px from
 * the same point (HandScene). Both DOM groups turn about that centre with the
 * same transform, and the hand turns with the same numbers — `tiltFor()` from
 * the shared motion store, eased at the same rate. Nothing is tuned to match;
 * it is the same maths three times.
 *
 * WHERE THE READER IS LOOKING
 * The tilt follows the store (src/lib/stage-motion.ts), not the stage: the
 * pointer measured across the whole viewport, so the phone keeps turning right
 * to the edge of the page and only comes to rest when the pointer returns to
 * the centre — or the gyroscope, on a phone, which the first tap unlocks (iOS
 * asks permission, and only over HTTPS). Round one tracked the pointer over the stage alone and
 * snapped back at its border; that is what this replaces.
 *
 * FOUR LAYERS, TWO CONTEXTS
 * Bottom to top: the back of the hand, the phone, the front of the hand, then
 * the holograms and the plates. The hand is two flat canvases — one keeps what
 * is behind the screen's plane, one what is in front — and they have to slot
 * between the DOM groups by paint order. That rules out the groups sharing a
 * preserve-3d parent, as they did in round one: anything flat in such a parent
 * is depth-sorted against the tilted phone and split along it. So the column
 * is flat. Each group is its own 3D rendering context under the column's one
 * perspective, and z-index does the layering: the canvases at `backZ` 0 and
 * `frontZ` 2, the phone at 1, the overlay at 3. That only resolves while
 * nothing between the column and the canvases is a stacking context, which is
 * why the hand's wrapper here has no z-index, transform or opacity of its
 * own (HandScene keeps the same rule for its root).
 *
 * Keeping the phone and the overlay apart also keeps the videos safe. A
 * grouping property — a filter, a mask, a backdrop filter, opacity on a
 * parent — inside a 3D rendering context makes the browser flatten and
 * re-rasterise that whole context every frame; in round one that context
 * held two playing videos, and the stage ran at two frames a second. Nothing
 * in the phone's context is one (Phone3D), and the overlay's has the same rule
 * (Holograms, Descriptor3D).
 *
 * WHAT RENDERS WHEN
 * The hand loads when the stage is within 600px of the viewport. The stage
 * fades in — `.fade-in-view` to `.is-in`, opacity and a 24px rise over 900ms,
 * the same entrance as every plate on the page — when it is within 200px; the
 * holograms mount then too, and the tilt loop runs only while the stage is on
 * screen and the tab is visible, because there is nothing to turn for nobody.
 * A reader without JavaScript is shown the stage as it is in the source
 * (globals.css handles `scripting: none`): the phone, the caption and the
 * figures, still.
 */

interface Props {
  /** 0 = all crushed, 1 = all Pristine. Lights the phone, the hand and the holograms. */
  t: number;
  /** The phone at its widest, bezel to bezel, px. It narrows with the column. */
  width?: number;
  /** The screen — a PreviewCompare or a PreviewCompare — and whatever it puts under itself. */
  children: ReactNode;
  className?: string;
  /** Draw the hand holding the phone. */
  hand?: boolean;
  /** Called once, on the first press or tap inside the stage. */
  onFirstGesture?: () => void;
  /** The screen's proportion, either way up (see Phone3D). */
  aspect?: number;
  /** Plates for the overlay group: the two measured-figure badges. */
  descriptors?: ReactNode;
  /** Print the `illustrative` legend on the screen. */
  illustrative?: boolean;
  /** The engagement figures at the Pristine end, for the holograms. */
  pristine?: Engagement;
  /** Float the four figures above the screen. Off where the screen carries
   *  its own rail (the tool's preview), so nothing is shown twice. */
  holograms?: boolean;
}

/* ---- tuning ------------------------------------------------------------ */
/** The eye's distance, px — the DOM's and the hand camera's, so they share one. */
const PERSPECTIVE = 1400;
/** The fraction of the remaining turn closed each frame. The hand eases the same. */
const EASE = 0.1;
/** ...and under reduced motion, which still follows but settles more slowly. */
const EASE_STILL = 0.05;
/** Closer than this to the target, the tilt is at rest and the loop stops. */
const SETTLED = 0.002;
/** Start loading the hand this far before the stage reaches the viewport. */
const NEAR_MARGIN = '600px';
/** The stage counts as on screen this far out: the fade fires, the tilt runs. */
const VIEW_MARGIN = '200px';
/** The layers, bottom to top. */
const Z_HAND_BACK = 0;
const Z_PHONE = 1;
const Z_HAND_FRONT = 2;
const Z_OVERLAY = 3;

const REST: Motion = { x: 0, y: 0, source: 'none' };
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const transformFor = (m: Motion) => {
  const { rx, ry } = tiltFor(m);
  return `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
};

export default function Stage({
  t, width = 400, children, className, hand = true, onFirstGesture,
  aspect = 16 / 9, descriptors, illustrative = false, pristine, holograms = true,
}: Props) {
  const lite = useSceneLite();
  const stageRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  /* Whether the stage intersects the viewport, for the tilt loop. */
  const onScreen = useRef(false);
  const gestured = useRef(false);

  const ratio = screenRatio(aspect);
  const tt = clamp01(t);
  const [near, setNear] = useState(false);
  const [inView, setInView] = useState(false);
  /* The phone's box, px: the column's width and the height that follows from
   * it. Starts at the widest and is corrected by measurement on mount. */
  const [box, setBox] = useState(() => ({ w: width, h: phoneHeight(width, ratio) }));
  const cy = box.h / 2;

  /* Measure the phone: the hand needs pixels, and the eye sits at its centre. */
  useEffect(() => {
    const col = columnRef.current;
    if (!col) return;
    const measure = () => {
      const w = col.clientWidth;
      if (!w) return;
      const h = phoneHeight(w, ratio);
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
    };
    if (typeof ResizeObserver === 'undefined') {
      const id = window.setTimeout(measure, 0);
      window.addEventListener('resize', measure);
      return () => {
        window.clearTimeout(id);
        window.removeEventListener('resize', measure);
      };
    }
    const ro = new ResizeObserver(measure);
    ro.observe(col);
    return () => ro.disconnect();
  }, [ratio]);

  /* The tilt, and what is on screen. */
  useEffect(() => {
    const stage = stageRef.current;
    const phone = phoneRef.current;
    const overlay = overlayRef.current;
    if (!stage || !phone || !overlay) return;
    const still =
      typeof window.matchMedia === 'function'
        ? stillQuery()
        : null;

    /* The tilt: one transform, written to both groups, eased toward the store. */
    let raf = 0;
    const target = { x: 0, y: 0 };
    const now = { x: 0, y: 0 };
    let source: Motion['source'] = 'none';
    const apply = () => {
      const tf = transformFor({ x: now.x, y: now.y, source });
      phone.style.transform = tf;
      overlay.style.transform = tf;
    };
    function schedule() {
      if (!raf && !document.hidden && onScreen.current) raf = requestAnimationFrame(paint);
    }
    function paint() {
      raf = 0;
      const k = still?.matches ? EASE_STILL : EASE;
      now.x += (target.x - now.x) * k;
      now.y += (target.y - now.y) * k;
      apply();
      if (Math.abs(target.x - now.x) > SETTLED || Math.abs(target.y - now.y) > SETTLED) schedule();
    }
    const unsubscribe = subscribeMotion((m) => {
      target.x = m.x;
      target.y = m.y;
      source = m.source;
      schedule();
    });
    const onVisibility = () => schedule();
    document.addEventListener('visibilitychange', onVisibility);

    /* Arriving: the fade is the class (`is-in`, set with `inView`); this is
     * the breath of air that goes with it. Silent until the first gesture has
     * unlocked audio, which is the rule for every sound on the site. */
    let arrived = false;
    const arrive = () => {
      if (arrived) return;
      arrived = true;
      play('whoosh', { gain: 0.5 });
    };

    /* On screen or not. Two observers: a wide one that only loads the hand,
     * and a nearer one that fades the stage in and gates the tilt loop. */
    let timer = 0;
    let ioNear: IntersectionObserver | null = null;
    let ioView: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'undefined') {
      onScreen.current = true;
      timer = window.setTimeout(() => {
        setNear(true);
        setInView(true);
        arrive();
        schedule();
      }, 0);
    } else {
      ioNear = new IntersectionObserver(
        (entries, io) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          setNear(true);
          io.disconnect();
        },
        { rootMargin: NEAR_MARGIN },
      );
      ioNear.observe(stage);
      ioView = new IntersectionObserver(
        (entries) => {
          const on = entries.some((e) => e.isIntersecting);
          onScreen.current = on;
          if (!on) return;
          setInView(true);
          arrive();
          schedule();
        },
        { rootMargin: VIEW_MARGIN },
      );
      ioView.observe(stage);
    }

    apply();
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      ioNear?.disconnect();
      ioView?.disconnect();
      phone.style.transform = '';
      overlay.style.transform = '';
    };
  }, []);

  const firstGesture = () => {
    if (gestured.current) return;
    gestured.current = true;
    onFirstGesture?.();
  };
  const onPointerDown = () => firstGesture();
  const onTouchStart = () => firstGesture();
  /*
   * iOS: the gyroscope needs a permission dialog, and a dialog nobody asked
   * for is the kind of thing that sends people away. So it is a button on
   * the stage — shown only where permission is needed and not yet given —
   * and the tap on it is the gesture that asks. Android needs nothing and
   * never sees it.
   */
  const [tiltAsk, setTiltAsk] = useState(false);
  useEffect(() => {
    const coarse =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (coarse && gyroNeedsPermission() && !gyroActive()) {
      const id = window.setTimeout(() => setTiltAsk(true), 0);
      return () => window.clearTimeout(id);
    }
  }, []);
  const askTilt = async () => {
    const ok = await requestGyro();
    if (ok) {
      setTiltAsk(false);
      play('reveal');
    }
  };

  const rest = transformFor(REST);
  const centre = `50% ${cy.toFixed(1)}px`;

  return (
    <div
      ref={stageRef}
      className={[
        'fade-in-view relative mx-auto max-w-6xl px-6 py-10 md:py-16',
        inView ? 'is-in' : '',
        className,
      ].filter(Boolean).join(' ')}
      onPointerDown={onPointerDown}
      onTouchStart={onTouchStart}
    >
      {tiltAsk && (
        <button
          type="button"
          onClick={askTilt}
          className="pill pill-primary pill-sm absolute left-1/2 top-2 z-[5] -translate-x-1/2 whitespace-nowrap"
        >
          Tilt your phone to compare
        </button>
      )}
      {/* The glass table: a pool of the screen's light under the phone, and a
          tighter, cooler one that brightens with the Pristine side. Each is
          painted once; only the second's opacity ever changes. (A mirrored
          reflection of the phone was tried here and removed — see the note in
          globals.css; it re-rendered both videos every frame.) */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[68%] h-[46%] w-[120%] -translate-x-1/2"
        style={{
          background:
            'radial-gradient(50% 50% at 50% 30%, rgba(91, 140, 255, 0.16), rgba(124, 92, 255, 0.06) 45%, transparent 70%)',
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[70%] h-[34%] w-[80%] -translate-x-1/2"
        style={{
          background:
            'radial-gradient(50% 50% at 50% 30%, rgba(78, 240, 255, 0.14), rgba(91, 140, 255, 0.05) 50%, transparent 70%)',
          opacity: 0.2 + 0.8 * tt,
          transition: 'opacity 150ms linear',
        }}
      />

      {/* The bloom: glowing icons behind the phone that come up with the
          split and go with it. Before the column in tree order and without a
          z-index, so it paints under everything the column holds. */}
      {inView && <EngagementBloom t={Math.round(tt * 50) / 50} />}

      {/* The column: one perspective, its eye at the phone's centre, and a
          flat stacking context in which the four layers are ordered by
          z-index — hand-back 0, phone 1, hand-front 2, overlay 3. */}
      <div
        ref={columnRef}
        className="relative mx-auto w-full"
        style={{ maxWidth: width, perspective: `${PERSPECTIVE}px`, perspectiveOrigin: centre }}
      >
        {/* The hand's box is the phone's; its canvases are centred on it and
            reach well past it. No z-index, transform or opacity on this
            wrapper — the canvases must find the column's stacking context. */}
        {/* Not on a lite device: this is a second WebGL context plus a Draco
            decode, behind a phone mockup that already carries the video. Two
            contexts on a phone is the single most reliable way to make it
            drop frames. */}
        {hand && near && !lite && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0"
            style={phoneBox(ratio)}
          >
            <HandScene
              width={box.w}
              height={box.h}
              glow={tt}
              backZ={Z_HAND_BACK}
              frontZ={Z_HAND_FRONT}
            />
          </div>
        )}

        {/* The phone: its own 3D context, turned about its centre. The screen
            and its caption are inside; nothing in here may be a grouping
            property, because two videos are. */}
        <div
          ref={phoneRef}
          className="relative"
          style={{
            zIndex: Z_PHONE,
            transformStyle: 'preserve-3d',
            transformOrigin: centre,
            transform: rest,
            willChange: 'transform',
          }}
        >
          <Phone3D t={tt} aspect={ratio} illustrative={illustrative}>
            {children}
          </Phone3D>
        </div>

        {/* The overlay: the plates and the holograms, in their own 3D context
            over the phone's box and turned exactly as the phone is. Nothing in
            it takes a pointer, so every press reaches the slider beneath. */}
        <div
          ref={overlayRef}
          className="pointer-events-none absolute inset-x-0 top-0"
          style={{
            ...phoneBox(ratio),
            zIndex: Z_OVERLAY,
            transformStyle: 'preserve-3d',
            transform: rest,
            willChange: 'transform',
          }}
        >
          {descriptors}
          {inView && holograms && <Holograms t={tt} pristine={pristine} className="inset-0" />}
        </div>
      </div>
    </div>
  );
}
