'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { sceneIsLite } from '@/lib/scene-tier';
import EngagementRail from '@/components/EngagementRail';
import { play } from '@/lib/sound';
import { splitFor, subscribeMotion, type Motion } from '@/lib/stage-motion';
import type { Engagement } from '@/lib/engagement';

/*
 * One phone, one video, a slider down the middle.
 *
 * WHY ONE VIDEO ELEMENT AND NOT TWO
 * Two <video> elements have two clocks and drift within seconds; nudging
 * currentTime to correct it never quite looks right. Here the clean side IS the
 * video element and the crushed side is a canvas drawing FROM that same element,
 * so the halves cannot disagree about which frame it is. Sync is structural, not
 * maintained. It also halves the decode cost, which matters on a phone.
 *
 * WHY THE CANVAS IS SIZED BY RATIO, NOT BY PIXELS
 * The obvious implementation draws the crushed side at TikTok's actual delivery
 * resolution — 720 on the short edge — and it is invisible. The phone mock is
 * about 300 CSS pixels wide, so a 720px canvas is still 2.4x sharper than the
 * screen showing it, and both halves look identical. Absolute pixels are the
 * wrong unit at preview scale.
 *
 * What is true at every scale is the RATIO: TikTok turns 2160 into 720, a 3x
 * linear reduction, throwing away 8/9ths of the detail. So the canvas is sized to
 * apply that same reduction relative to the display size — 3x fewer pixels across
 * the width actually on screen. That is an honest rendering of the same loss, and
 * unlike a blur it is a real downscale-and-upscale, which is what a lower
 * rendition physically is.
 *
 * The frame rate is simulated the same way: each frame is held for the full
 * 1/30s interval, so motion is genuinely sampled at the lower rate.
 *
 * ENGAGEMENT NUMBERS ARE ILLUSTRATIVE and labelled as such under the frame.
 * They sit in a feed-style rail down the right edge (EngagementRail) and climb
 * as the handle moves toward the clean side. Deliberately generic chrome — no
 * TikTok logo, wordmark or copied iconography.
 *
 * THE FRAME IS NOT HERE
 * The app page mounts this inside the site's Stage, which puts it in the same
 * phone the landing page uses (Phone3D: bezel, ring, notch, thickness, the
 * hand behind it, the tilt), so this component is the screen and nothing
 * else. `wrapRef` is the screen itself, so the canvas sizing and the drag maths
 * measure the picture and not the frame. The note that used to sit under the
 * bezel is exported separately as `PreviewNote` for the page to place beneath
 * the stage: rendered here it would land inside the phone.
 *
 * WHAT THE STAGE ASKS OF IT
 * `onPositionChange` reports the split so the stage can light the phone and
 * the hand by it; `motionDrive` lets the reader's motion — the pointer's place
 * across the page, or the phone's roll — move the split while nobody is
 * dragging. Both are optional and the slider is unchanged without them.
 *
 * NO FILTER ON THE SCREEN
 * The crushed side used to carry a CSS filter (a little desaturation and
 * contrast loss, the look of a re-encode) and the handle a backdrop blur.
 * Inside the stage's 3D context neither can be composited on its own: the
 * browser re-rasterises the whole context — video included — every frame
 * (Holograms.tsx records the two-frames-a-second version of this). The same
 * look is now applied by the 2D context as it draws, on a canvas a few hundred
 * pixels wide, at most `targetFps` times a second; where a browser has no
 * `ctx.filter` the downscale alone carries the comparison, which is the honest
 * part anyway. The handle is plain glass.
 */

interface Props {
  src: string;
  width: number;
  height: number;
  fps: number;
  bitrateMbps: number;
  crushedLikes: number;
  pristineLikes: number;
  handle?: string;
  sound?: string;
  targetShortEdge?: number;
  targetFps?: number;
  /** Called whenever the split moves, with the divider's position in percent. */
  onPositionChange?: (pos: number) => void;
  /**
   * Let the reader's motion move the split while nobody is dragging: `pos`
   * eases toward splitFor(motion.x) on every reading from stage-motion — the
   * pointer's place across the page on a desktop, the phone's roll on a
   * handset. A drag wins while it lasts; a keyboard step lands and holds until
   * the next reading; touch never drives it.
   */
  motionDrive?: boolean;
  /** The figures at the clean end of the rail; the page draws a fresh set per file. */
  pristine?: Engagement;
}

/*
 * Roughly what a phone shows, in physical pixels across. Both renditions are
 * scaled to this before anyone sees them, so it is the denominator that makes
 * the comparison honest.
 */
const PHONE_SCREEN_PX = 1080;

/**
 * How much smaller the crushed side is drawn than the clean one, as a fraction.
 *
 * Relative to the SCREEN, not the source: nobody watches a 4K file at 4K on a
 * phone. Both versions land on a screen about 1080 pixels across, so the real
 * comparison is the delivered rung stretched to that against a source that
 * already fills it. And only ever delivered-against-clean: a 720p source
 * delivered at 720p loses nothing, so a source at or below the rung is drawn
 * at 1 -- pretending otherwise would be a lie in our own favour.
 *
 * Exported so it can be pinned by a test; the landing page and the tool page
 * both draw with it.
 */
export function crushReduction(shortEdge: number, targetShortEdge: number, screenPx = PHONE_SCREEN_PX): number {
  const delivered = Math.min(shortEdge, targetShortEdge);
  const clean = Math.min(shortEdge, screenPx);
  return Math.min(1, delivered / clean);
}

/*
 * The look of a re-encode on the crushed side — a little less colour, a little
 * less contrast — applied by the 2D context as it draws, never by CSS on the
 * canvas (see NO FILTER ON THE SCREEN above).
 */
const CRUSH_LOOK = 'saturate(0.8) contrast(0.93) brightness(0.94)';

/* Motion drive: the fraction of the remaining distance closed per 60 Hz frame. */
const FOLLOW = 0.12;

/* The chime rings as the split crosses the middle toward Pristine... */
const REVEAL_AT = 50;
/* ...and re-arms only once it has come clearly back, so a pointer resting on
 * the line does not ring it every frame. Mirrors EngagementRail's pop. */
const REARM_ABOVE = 56;

/* The keys a range input steps on; each step is a tick. */
const STEP_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/*
 * `crushedLikes` and `pristineLikes` remain part of Props — the app page passes
 * them — but every count on the rail comes from src/lib/engagement.ts, so they
 * are accepted and not read.
 */
export default function PreviewCompare({
  src, width, height, fps, bitrateMbps,
  handle = '@yourhandle',
  sound = 'original sound — your edit',
  targetShortEdge = 720, targetFps = 30,
  onPositionChange, motionDrive = false, pristine,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pos, setPos] = useState(50);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    const c = canvasRef.current;
    const wrap = wrapRef.current;
    if (!v || !c || !wrap) return;
    const ctx = c.getContext('2d', { alpha: false });
    if (!ctx) return;
    // Resizing a canvas resets its context, filter included, so the look is set
    // per draw rather than once here.
    const canFilter = 'filter' in ctx;

    /*
     * THE CLEAN SIDE IS THE VIDEO. ONLY THE CRUSHED SIDE IS DRAWN.
     *
     * The previous version drew both halves onto one full-resolution canvas so
     * they could never be a frame apart. On a phone that was the lag: every
     * presented frame of a 4K60 file was copied out of the decoder into a
     * device-pixel canvas twice -- a GPU-to-CPU trip per copy -- while the page
     * was decoding the same 4K60 underneath. The decoder was being starved by
     * the thing showing its output.
     *
     * The <video> element composites for free: the decoder hands frames to
     * the compositor and nothing touches them. So the clean side is the
     * element again, and the only copy per frame is the SMALL one -- the
     * crushed canvas, at the reduced size that is the whole argument.
     *
     * WHY THEY ARE STILL THE SAME FRAME
     * `requestVideoFrameCallback` fires when the browser presents a new video
     * frame, with that frame ready to draw. Drawing there means the canvas
     * shows the very frame the element is compositing -- not the frame a
     * requestAnimationFrame happened to catch, and not one held back to fake a
     * lower rate (that throttle was what read as the halves being out of
     * step). Where the API is missing, requestAnimationFrame stands in and the
     * canvas is at worst the frame the element just left.
     */
    let raf = 0;
    let vfc = 0;
    const rvfc = v as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    const hasVfc = typeof rvfc.requestVideoFrameCallback === 'function';

    const size = () => {
      if (!v.videoWidth) return;
      const shortEdge = Math.min(v.videoWidth, v.videoHeight);
      const aspect = v.videoHeight / v.videoWidth;

      /*
       * The reduction is relative to the SCREEN, not to the source.
       *
       * The first version compared the delivered rung to the source -- 720
       * against 2160 -- and drew the crushed side at a third of the width. That
       * is not what anyone sees. Nobody watches a 4K file at 4K on a phone: both
       * versions are displayed on a screen about 1080 physical pixels wide. So
       * the real comparison is 720 upscaled to 1080 (a 1.5x stretch) against a
       * source that already meets or exceeds 1080. A third was roughly four
       * times too destructive, which is why the text was unreadable.
       *
       * Capped at 1: a source already below the rung is not made worse by it,
       * and pretending otherwise would be a lie in our own favour.
       */
      const reduction = crushReduction(shortEdge, targetShortEdge);

      // Work in device pixels, or a 2x screen hides the difference entirely;
      // but no more than 2x on a lite device, where every pixel is a copy.
      const dpr = Math.min(window.devicePixelRatio || 1, sceneIsLite() ? 2 : 3);
      const physicalW = (wrap.clientWidth || 300) * dpr;

      c.width = Math.max(16, Math.round(physicalW * reduction));
      c.height = Math.max(16, Math.round(physicalW * reduction * aspect));
    };

    const paint = () => {
      if (v.readyState >= 2 && c.width > 0) {
        if (canFilter) ctx.filter = CRUSH_LOOK;
        ctx.drawImage(v, 0, 0, c.width, c.height);
      }
    };
    const onFrame = () => {
      paint();
      vfc = rvfc.requestVideoFrameCallback!(onFrame);
    };
    const tick = () => {
      paint();
      raf = requestAnimationFrame(tick);
    };

    /*
     * `play()` is rejected more often than the autoplay rules suggest -- iOS Low
     * Power Mode, Data Saver, a backgrounded tab. A refusal is never final: the
     * next `canplay` and the first touch anywhere both try again.
     */
    let starting = false;
    const start = () => {
      if (starting || !v.paused || v.readyState < 3) return;
      starting = true;
      void v.play().catch(() => {}).finally(() => { starting = false; });
    };
    const onGesture = () => { if (v.paused) start(); };

    v.addEventListener('loadedmetadata', size);
    v.addEventListener('canplay', start);
    document.addEventListener('pointerdown', onGesture, { passive: true, capture: true });
    document.addEventListener('touchstart', onGesture, { passive: true, capture: true });
    if (v.videoWidth) size();
    const ro = new ResizeObserver(size);
    ro.observe(wrap);

    start();
    if (hasVfc) {
      /* One draw per presented frame, and none at all while paused. The first
       * paint is immediate so a refused autoplay still shows a correct split. */
      paint();
      vfc = rvfc.requestVideoFrameCallback!(onFrame);
    } else {
      raf = requestAnimationFrame(tick);
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (vfc && rvfc.cancelVideoFrameCallback) rvfc.cancelVideoFrameCallback(vfc);
      ro.disconnect();
      v.removeEventListener('loadedmetadata', size);
      v.removeEventListener('canplay', start);
      document.removeEventListener('pointerdown', onGesture, { capture: true });
      document.removeEventListener('touchstart', onGesture, { capture: true });
    };
  }, [src, targetShortEdge]);

  /*
   * Every change to the split goes through here, and the parent hears about
   * it in the same tick — not from an effect on `pos`, which scheduled a
   * second render from inside React's passive-effect flush on every frame of
   * a drag or a motion-drive (the pattern behind React's "maximum update
   * depth" warning). One batched render per frame instead.
   */
  const posRef = useRef(pos);
  const reportRef = useRef(onPositionChange);
  useEffect(() => { reportRef.current = onPositionChange; }, [onPositionChange]);
  /*
   * The chime, on the crossing toward Pristine, played in the same tick as
   * the crossing rather than from an effect after the paint. Armed while the
   * split is at or past the line on the crushed side, so mounting past it
   * does not ring and the first crossing does; it re-arms only once the split
   * has come clearly back. The rail's pop lands on the same crossing.
   */
  const revealArmed = useRef(pos >= REVEAL_AT);
  const commitPos = useCallback((next: number) => {
    posRef.current = next;
    setPos(next);
    reportRef.current?.(next);
    if (next >= REARM_ABOVE) revealArmed.current = true;
    if (revealArmed.current && next < REVEAL_AT) {
      revealArmed.current = false;
      play('reveal');
    }
  }, []);
  /* The starting split, once, so a parent that renders from it is not stale. */
  useEffect(() => { reportRef.current?.(posRef.current); }, []);

  const setFromClientX = useCallback((clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    commitPos(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  }, [commitPos]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => { e.preventDefault(); setFromClientX(e.clientX); };
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragging, setFromClientX]);

  /*
   * Follow the reader's motion.
   *
   * Eased rather than snapped — about 12% of the remaining distance per 60 Hz
   * frame, scaled to the real frame time so a 120 Hz display is not twice as
   * stiff — so a hand crossing the page moves the divider like a slow wipe
   * instead of a flicker. A drag wins while it is happening: the effect is
   * re-run with `dragging`, and a drag in progress is not subscribed at all.
   * Touch never drives it (the store ignores fingers); on a phone the readings
   * are the gyroscope's. `posRef` tracks the split between React commits so
   * consecutive frames do not read a stale value.
   */
  useEffect(() => {
    if (!motionDrive || dragging) return;
    let raf = 0;
    let last = 0;
    let target: number | null = null;

    const step = (now: number) => {
      raf = 0;
      if (target === null) return;
      const dt = last ? Math.min(48, now - last) : 16.7;
      last = now;
      const p = posRef.current;
      const k = 1 - Math.pow(1 - FOLLOW, dt / 16.7);
      const next = Math.abs(target - p) < 0.06 ? target : p + (target - p) * k;
      commitPos(next);
      if (next !== target) raf = requestAnimationFrame(step);
      else last = 0;
    };
    /* A pointer puts the divider where the pointer is, measured across the
     * screen itself — one edge of the phone to the other, as a drag would —
     * and holds at that end past either edge. A gyroscope is the roll. */
    const targetFor = (m: Motion) => {
      const el = wrapRef.current;
      if (m.source === 'pointer' && el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) {
          const clientX = ((m.x + 1) / 2) * window.innerWidth;
          return Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100));
        }
      }
      return splitFor(m.x);
    };
    const unsubscribe = subscribeMotion((m) => {
      // The store's first call is whatever it last saw; before anyone has
      // moved, that is nothing, and nothing should not move the split.
      if (m.source === 'none') return;
      target = targetFor(m);
      if (!raf && !document.hidden) raf = requestAnimationFrame(step);
    });

    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
    };
  }, [motionDrive, dragging, commitPos]);

  const crushedSpec = `${Math.round(targetShortEdge)}×${Math.round(targetShortEdge * (height / width))} · ${targetFps}fps · 2.9 Mbps`;
  const pristineSpec = `${width}×${height} · ${fps.toFixed(0)}fps · ${bitrateMbps.toFixed(1)} Mbps`;

  // How far the handle sits toward the clean side: 0 is all crushed, 1 is all
  // clean. Drives the rail; the stage reads the same figure via onPositionChange.
  const t = 1 - pos / 100;

  return (
    <div
      ref={wrapRef}
      onPointerDown={(e) => { setDragging(true); setFromClientX(e.clientX); }}
      className="relative aspect-[9/19.5] w-full touch-none select-none overflow-hidden
                 rounded-[38px] bg-black"
    >
      {/* Clean side -- the video itself, composited by the browser at no cost.
          Not autoPlay: the effect starts it and retries a refusal. */}
      <video
        ref={videoRef}
        src={src}
        muted loop playsInline
        className="absolute inset-0 h-full w-full object-cover"
      />

      {/* Crushed side, clipped to the left of the handle, drawn from the same
          presented frame (see the effect). Its look is drawn in (CRUSH_LOOK),
          so the element itself carries no filter. */}
      <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>

      {/* Legibility wash, top and bottom, over both halves. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/65 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/80 to-transparent" />

      {/* ---- headers: always both visible, so the comparison reads at a glance ---- */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-between gap-2 px-3 pt-8 pb-3">
        <div className="max-w-[46%]">
          <div className="legend text-[8.5px] leading-tight text-white/55">Without Pristine</div>
          <div className="tabular mt-1 text-[9.5px] leading-tight text-white/75">{crushedSpec}</div>
        </div>
        <div className="max-w-[52%] text-right">
          <div className="legend text-[8.5px] leading-tight text-accent-soft">With Pristine</div>
          <div className="tabular mt-1 text-[9.5px] font-medium leading-tight text-white">{pristineSpec}</div>
        </div>
      </div>

      {/* ---- engagement rail: a feed's right rail, lit by how much clean side shows ---- */}
      <EngagementRail t={t} pristine={pristine} className="absolute right-2.5 bottom-[88px]" />

      {/* ---- caption: the same post either way, so it spans both halves ---- */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3.5">
        <div className="text-[12px] font-semibold text-white">{handle}</div>
        <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-white/80">
          <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" className="shrink-0">
            <path d="M9 18V6l10-2v12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
            <circle cx="6.5" cy="18" r="2.5" fill="currentColor" />
            <circle cx="16.5" cy="16" r="2.5" fill="currentColor" />
          </svg>
          <span className="truncate">{sound}</span>
        </div>
      </div>

      {/* ---- handle: a hairline that goes out at either end (one whole video,
              no line on it), and a glass disc that stays on the screen at both
              ends so it can always be dragged back ---- */}
      <div
        className="pointer-events-none absolute inset-y-0 -ml-px w-px bg-white/85 shadow-[0_0_12px_rgba(255,255,255,0.5)] transition-opacity duration-150"
        style={{ left: `${pos}%`, opacity: pos < 0.75 || pos > 99.25 ? 0 : 1 }}
      />
      <div className="pointer-events-none absolute inset-y-0" style={{ left: `clamp(22px, ${pos}%, calc(100% - 22px))` }}>
        <div className="absolute top-1/2 -left-[22px] grid h-11 w-11 -translate-y-1/2 place-items-center
                        rounded-full border border-white/30 bg-white/15 text-white
                        shadow-[0_10px_30px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.3)]">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M9.5 7.5 5 12l4.5 4.5M14.5 7.5 19 12l-4.5 4.5" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </div>
      </div>

      <input
        type="range" min={0} max={100} value={Math.round(pos)}
        onChange={(e) => commitPos(Number(e.target.value))}
        onKeyDown={(e) => { if (STEP_KEYS.has(e.key)) play('tick'); }}
        aria-label="Compare an ordinary upload with Pristine"
        className="absolute inset-x-0 bottom-0 h-10 w-full cursor-ew-resize opacity-0"
      />
    </div>
  );
}

/**
 * The note under the phone: what the preview shows and what it does not.
 * Rendered by the page beneath the stage, not by the screen above, so it
 * never lands inside the frame.
 */
export function PreviewNote({ bitrateMbps }: { bitrateMbps: number }) {
  return (
    <p className="mx-auto mt-6 max-w-xl text-center text-[11.5px] leading-relaxed text-dim">
      Drag to compare. This shows the resolution and frame rate you lose; the drop from{' '}
      <span className="tabular text-muted">{bitrateMbps.toFixed(1)}</span> to{' '}
      <span className="tabular text-muted">2.9 Mbps</span> of compression is not simulated,
      and on real footage it is the larger difference. Like counts are illustrative.
    </p>
  );
}
