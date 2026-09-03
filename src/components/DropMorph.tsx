'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';
import { play } from '@/lib/sound';

/*
 * The drop zone becomes the phone.
 *
 * Dropping a file used to cut from one screen (the zone) to another (the
 * readouts and the preview). Now the zone lifts off as a slab of the same
 * material, flies to where the phone is about to be — the page scrolling
 * underneath it to bring the phone into view — reshapes into the phone's
 * rounded body on the way, and lands as the real phone fades up under it with
 * the reader's own video already playing on its screen; a flash of the
 * screen's light marks the moment. Then the slab is gone.
 *
 * WHY IT IS A GHOST AND NOT THE REAL ELEMENTS
 * The zone and the phone live in different branches of the page (`idle` and
 * `ready`), so neither exists on both sides of the change. The last place the
 * zone was seen is remembered in a layout effect while it exists (the scan is
 * synchronous enough that "while scanning" is the moment before it goes), and
 * the phone's box is measured in the same commit that mounts it, before
 * paint. The ghost is one fixed element animated with the Web Animations API
 * over left/top/width/height — a real box animation rather than a scaled
 * transform, so its corners stay round instead of stretching — and only for
 * under a second.
 *
 * Nothing about the page's state or flow is touched: this reads `stage` and
 * two refs. Under reduced motion it only scrolls the phone into view.
 */

type Stage = 'idle' | 'scanning' | 'ready' | 'error';

interface Props {
  /**
   * Bring the phone into view but do not fly anything to it. For a file
   * restored after a round trip (sign-in, Stripe) there was no drop to fly
   * from, and the flight costs a second decode of the reader's video while
   * the real stage waits at opacity 0 -- on a page that has just loaded, that
   * is a black screen for as long as anything stalls.
   */
  skip?: boolean;
  stage: Stage;
  /** The drop zone (the label), while it exists. */
  dropRef: RefObject<HTMLElement | null>;
  /** The wrapper around the stage once it exists; the phone body inside it is the target. */
  stageRef: RefObject<HTMLElement | null>;
  /** The reader's video, once it has a URL: it plays on the slab in flight,
   *  so the picture is there from the moment the zone lifts off and not only
   *  once the phone has landed. */
  videoSrc?: string | null;
}

/* The flight, and the settle at the end of it during which the slab fades. */
const FLY_MS = 780;
const SETTLE_MS = 240;
const EASE = 'cubic-bezier(0.22, 0.9, 0.18, 1)';
/* Corner radii: the drop plate's, and the phone body's. */
const RADIUS_FROM = 16;
const RADIUS_TO = 46;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const frame = (b: Box, radius: number, opacity: number) => ({
  left: `${b.left}px`,
  top: `${b.top}px`,
  width: `${b.width}px`,
  height: `${b.height}px`,
  borderRadius: `${radius}px`,
  opacity,
});

export default function DropMorph({ stage, dropRef, stageRef, videoSrc, skip = false }: Props) {
  const lastDrop = useRef<Box | null>(null);

  useLayoutEffect(() => {
    if (stage !== 'ready') {
      /* Remember where the zone is for as long as it exists. */
      const el = dropRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        lastDrop.current = { left: r.left, top: r.top, width: r.width, height: r.height };
      }
      return;
    }

    const from = lastDrop.current;
    lastDrop.current = null;
    const wrap = stageRef.current;
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const bezel = wrap?.querySelector<HTMLElement>('.phone-body') ?? wrap;
    const rect = bezel?.getBoundingClientRect();
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[DropMorph] ready', {
        from,
        wrap: !!wrap,
        bezel: !!bezel && bezel !== wrap,
        rect: rect ? [rect.left, rect.top, rect.width, rect.height].map(Math.round) : null,
        reduced,
      });
    }
    if (!wrap || !bezel || !rect) return;
    if (rect.width < 1 || rect.height < 1) return;

    /* Where the phone will sit once the page has scrolled to show it: centred
     * when it fits the viewport, otherwise a little below the top. The slab
     * flies to that spot while the scroll brings the phone to meet it. */
    const desiredTop =
      rect.height + 48 <= window.innerHeight ? (window.innerHeight - rect.height) / 2 : 24;
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const scrollTarget = Math.min(maxScroll, Math.max(0, window.scrollY + rect.top - desiredTop));
    const finalTop = rect.top - (scrollTarget - window.scrollY);
    window.scrollTo({ top: scrollTarget, behavior: reduced ? 'auto' : 'smooth' });

    if (skip || reduced || !from || typeof wrap.animate !== 'function') return;

    const target: Box = { left: rect.left, top: finalTop, width: rect.width, height: rect.height };

    const ghost = document.createElement('div');
    ghost.className = 'drop-morph';
    ghost.setAttribute('aria-hidden', 'true');
    /* The reader's own video, fading up on the slab over the first half of
     * the flight: the zone turns into the phone with the picture already on
     * it, and the real phone underneath takes over on landing. */
    if (videoSrc) {
      const v = document.createElement('video');
      v.src = videoSrc;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.autoplay = true;
      ghost.appendChild(v);
      void v.play().catch(() => {});
      v.animate(
        [{ opacity: 0 }, { opacity: 1, offset: 0.5 }, { opacity: 1 }],
        { duration: FLY_MS, easing: 'ease-out', fill: 'forwards' },
      );
    }
    document.body.appendChild(ghost);

    /* The real stage waits, unseen, until the slab has all but landed. */
    wrap.style.opacity = '0';
    play('whoosh', { gain: 0.6 });

    const fly = ghost.animate(
      [
        frame(from, RADIUS_FROM, 1),
        { ...frame(target, RADIUS_TO, 1), offset: FLY_MS / (FLY_MS + SETTLE_MS) },
        frame(target, RADIUS_TO, 0),
      ],
      { duration: FLY_MS + SETTLE_MS, easing: EASE, fill: 'forwards' },
    );
    fly.onfinish = () => ghost.remove();

    const reveal = wrap.animate(
      [
        { opacity: 0, transform: 'scale(0.985)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      { duration: 520, delay: FLY_MS - 160, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'both' },
    );
    reveal.onfinish = () => {
      wrap.style.opacity = '';
      reveal.cancel();
    };

    /* The screen coming on: a burst of its light where the slab lands. */
    let flash: HTMLDivElement | null = null;
    const flashTimer = window.setTimeout(() => {
      flash = document.createElement('div');
      flash.className = 'drop-flash';
      flash.setAttribute('aria-hidden', 'true');
      Object.assign(flash.style, frame(target, RADIUS_TO, 1));
      document.body.appendChild(flash);
      const burst = flash.animate(
        [
          { opacity: 0.85, transform: 'scale(0.94)' },
          { opacity: 0, transform: 'scale(1.12)' },
        ],
        { duration: 640, easing: 'ease-out', fill: 'forwards' },
      );
      burst.onfinish = () => {
        flash?.remove();
        flash = null;
      };
    }, FLY_MS - 60);

    return () => {
      window.clearTimeout(flashTimer);
      fly.cancel();
      ghost.remove();
      flash?.remove();
      reveal.cancel();
      wrap.style.opacity = '';
    };
  }, [stage, dropRef, stageRef, videoSrc, skip]);

  return null;
}
