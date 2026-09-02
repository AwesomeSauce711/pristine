'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { play } from '@/lib/sound';
import { splitFor, subscribeMotion, type Motion } from '@/lib/stage-motion';
import { sceneIsLite } from '@/lib/scene-tier';

/*
 * The before/after comparison.
 *
 * Both clips are what TikTok ACTUALLY served for the same 10 seconds of the
 * same footage, uploaded minutes apart from the same account — one patched, one
 * not. They are re-encoded here to the same display size and settings, so the
 * only thing that differs is what TikTok did to each. The badges carry the real
 * delivered figures.
 *
 * Two videos playing in lockstep is the whole trick, and browsers will not keep
 * them in sync on their own: independent <video> elements drift, and a drift of
 * even a few frames makes the comparison look dishonest because the two sides
 * show different moments. So one is the clock and the other is corrected
 * against it whenever it slips.
 *
 * Nothing loads until the component is on screen. Together the clips are ~8 MB,
 * which is far too much to put in front of someone who may never scroll to it.
 *
 * THE FRAME IS NOT HERE
 * This is the screen: the two clips, the divider and its glass handle. The
 * phone around it — bezel, ring, notch, and the `illustrative` legend for the
 * engagement figures the stage floats above it — is Phone3D's, and the two
 * measured-figure badges that used to sit in the screen's corners are the
 * stage's Descriptor3D plates, carrying the same words. `wrapRef` stays on the
 * screen itself, so the drag maths measure the picture and not the frame.
 *
 * Two optional props let the stage drive and read the split: `motionDrive`
 * makes the divider follow the reader — the pointer's place across the whole
 * page, or the roll of the phone in their hand — while nobody is dragging,
 * and `onPositionChange` reports the split so the holograms can climb with
 * it. Neither changes what the slider does on its own. Two sounds are added
 * (src/lib/sound.ts): the chime when the split crosses to the Pristine side,
 * and a tick for each keyboard step.
 */

interface Props {
  /**
   * ONE file holding BOTH renditions side by side: the crushed one in the left
   * half, the pristine one in the right. See the note at the top for why this
   * is a single file rather than two.
   */
  src: string;
  /** The composited still — crushed left of centre, pristine right of it. */
  poster: string;
  /** Called whenever the split moves, with the divider's position in percent. */
  onPositionChange?: (pos: number) => void;
  /**
   * Follow the reader: with no drag in progress, the split eases toward
   * `splitFor()` of the motion store's horizontal reading — the pointer across
   * the whole viewport, or the gyroscope's roll — left widening the compressed
   * side, right the Pristine side. Touch never drives it.
   */
  motionDrive?: boolean;
}

/*
 * 0.12s was too loose — roughly seven frames at 60fps, which is plainly visible
 * as the two halves showing different moments. Two frames is under the threshold
 * where a viewer reads it as lag rather than as a comparison.
 *
 * This slider genuinely needs two elements: the halves are two DIFFERENT files
 * (what TikTok served for a patched upload versus an unpatched one), so unlike
 * the in-app preview there is no single source to draw both from. Correction is
 * the only option here.
 */
/*
 * The chime plays when the split crosses the midpoint toward Pristine, and
 * re-arms only once it has come clearly back — the same hysteresis as the
 * holograms' pop, so a pointer hovering on the line does not ring every frame.
 * The numbers are the holograms' (t = 0.5 and 0.44) in the slider's own 2–98
 * travel, so the chime, the pop and the lit plate are one moment.
 */
const REVEAL_AT = 52;
const REVEAL_REARM_ABOVE = 58;

/**
 * Where each half is read from, and where it lands.
 *
 * Exported so the geometry is testable. There is no timing left to test: both
 * rectangles are read from the SAME video element on the SAME draw, so they are
 * the same frame by construction rather than by correction.
 */
export function splitDraw(videoW: number, videoH: number, canvasW: number, canvasH: number, posPct: number) {
  const half = videoW / 2;
  const clip = Math.max(0, Math.min(canvasW, (canvasW * posPct) / 100));
  return {
    /* The crushed half, under everything, from the left of the source. */
    crushed: { sx: 0, sy: 0, sw: half, sh: videoH, dx: 0, dy: 0, dw: canvasW, dh: canvasH },
    /* The pristine half, from the right of the source, clipped to the reveal. */
    pristine: { sx: half, sy: 0, sw: half, sh: videoH, dx: 0, dy: 0, dw: canvasW, dh: canvasH },
    /* x where the pristine side starts. At 100 it is canvasW: nothing is drawn. */
    clip,
    pristineVisible: clip < canvasW,
  };
}

/* Who wants to know the split moved, between video frames (see WHEN TO DRAW). */
const splitListeners = new Set<() => void>();

export default function CompareSlider({
  src, poster, onPositionChange, motionDrive = false,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [pos, setPos] = useState(50);
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Only fetch the clips once the slider is actually approaching the viewport.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      /* No observer to wait for: show the clips now. The lint rule against a
       * synchronous setState in an effect is about cascades; this is a
       * one-time fallback on a browser that cannot observe, kept as it was. */
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);


  /*
   * Every change to the split goes through here, and the parent hears about
   * it in the same tick. It used to be reported from an effect on `pos`,
   * which meant each frame of a drag or a motion-drive scheduled a second
   * render from inside React's passive-effect flush — the exact pattern
   * React's "maximum update depth" warning watches for, and it fired once
   * the split had been moving for a while. Reporting synchronously batches
   * the child's and the parent's updates into one render instead.
   */
  const posRef = useRef(pos);
  const reportRef = useRef(onPositionChange);
  useEffect(() => { reportRef.current = onPositionChange; }, [onPositionChange]);
  /* The chime, once per crossing toward Pristine, played in the same tick as
   * the crossing itself rather than from an effect after the paint — so it
   * lands with the picture, not a frame behind it. Armed from the start: the
   * first reveal is the one that matters. */
  const revealArmed = useRef(true);
  const commitPos = useCallback((next: number) => {
    for (const fn of splitListeners) fn();
    posRef.current = next;
    setPos(next);
    reportRef.current?.(next);
    if (next > REVEAL_REARM_ABOVE) revealArmed.current = true;
    else if (revealArmed.current && next <= REVEAL_AT) {
      revealArmed.current = false;
      play('reveal');
    }
  }, []);

  /*
   * ONE video, drawn twice.
   *
   * This used to be two <video> elements corrected against each other, and no
   * amount of correction was ever going to be right. Two elements are two
   * independent clocks: they start at whatever moment each finishes buffering,
   * they drift, and `currentTime` is quantised to the frame, so even the
   * MEASUREMENT of how far apart they are is only accurate to a frame. Every
   * version of that machinery either corrected too eagerly and juddered, or too
   * loosely and sat visibly a frame or two apart. Both failures were reported.
   *
   * So there is one element now, holding both renditions side by side in a
   * single file, and one canvas that draws the left half and then the right
   * half clipped to the reveal. The two sides are the same frame BY
   * CONSTRUCTION — they are read from one element in one draw call pair, on one
   * tick. There is no clock to drift, nothing to correct, and no threshold to
   * get wrong. It also halves the decoders, which is what the page could least
   * afford on a phone.
   *
   * Both halves are still exactly what TikTok served; welding them into one
   * file changes how they are delivered, not what they are.
   *
   * A further gain: the split stays coherent even when the clip is not running.
   * If autoplay is refused the canvas still draws the current frame, so the
   * comparison reads correctly as a still instead of showing two mismatched
   * frozen pictures.
   */
  useEffect(() => {
    if (!visible) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    const wrap = wrapRef.current;
    if (!v || !c || !wrap) return;
    const ctx = c.getContext('2d', { alpha: false });
    if (!ctx) return;

    let raf = 0;
    let starting = false;

    /* Device pixels, or a 2x screen throws away the difference being shown. */
    const size = () => {
      if (!v.videoWidth) return;
      const dpr = Math.min(window.devicePixelRatio || 1, sceneIsLite() ? 2 : 3);
      const w = Math.max(16, Math.round((wrap.clientWidth || 300) * dpr));
      c.width = w;
      c.height = Math.max(16, Math.round((w * v.videoHeight) / (v.videoWidth / 2)));
    };

    const draw = () => {
      if (v.readyState >= 2 && v.videoWidth && c.width > 0) {
        const g = splitDraw(v.videoWidth, v.videoHeight, c.width, c.height, posRef.current);
        const { crushed: k, pristine: pr } = g;
        ctx.drawImage(v, k.sx, k.sy, k.sw, k.sh, k.dx, k.dy, k.dw, k.dh);
        if (g.pristineVisible) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(g.clip, 0, c.width - g.clip, c.height);
          ctx.clip();
          ctx.drawImage(v, pr.sx, pr.sy, pr.sw, pr.sh, pr.dx, pr.dy, pr.dw, pr.dh);
          ctx.restore();
        }
      }
    };

    /*
     * WHEN TO DRAW
     * `requestVideoFrameCallback` fires once per presented video frame — sixty
     * times a second for this clip, not the 120 a ProMotion phone's animation
     * frame runs at, and not at all while the clip is paused or buffering. That
     * halves the work on the phones that could least afford it and lets the
     * page go quiet whenever the picture is not changing. But the handle moves
     * between video frames, so a drag also draws, on its own animation frame:
     * the divider must follow the finger, not the clip.
     */
    let vfc = 0;
    const rvfc = v as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    const hasVfc = typeof rvfc.requestVideoFrameCallback === 'function';
    const onFrame = () => { draw(); vfc = rvfc.requestVideoFrameCallback!(onFrame); };
    const tick = () => { draw(); raf = requestAnimationFrame(tick); };
    let dragRaf = 0;
    const onSplit = () => {
      if (!hasVfc || dragRaf) return;
      dragRaf = requestAnimationFrame(() => { dragRaf = 0; draw(); });
    };

    /*
     * `play()` is rejected more often than the autoplay rules suggest — iOS Low
     * Power Mode, Data Saver, a backgrounded tab, some Android browsers until
     * the page is touched. So a refusal is never final: the next `canplay` and
     * the first touch anywhere both try again.
     */
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
    const ro = new ResizeObserver(size);
    ro.observe(wrap);

    if (v.videoWidth) size();
    start();
    if (hasVfc) {
      draw();
      vfc = rvfc.requestVideoFrameCallback!(onFrame);
      v.addEventListener('loadedmetadata', draw);
      splitListeners.add(onSplit);
    } else {
      raf = requestAnimationFrame(tick);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (dragRaf) cancelAnimationFrame(dragRaf);
      if (vfc && rvfc.cancelVideoFrameCallback) rvfc.cancelVideoFrameCallback(vfc);
      v.removeEventListener('loadedmetadata', draw);
      splitListeners.delete(onSplit);
      ro.disconnect();
      v.removeEventListener('loadedmetadata', size);
      v.removeEventListener('canplay', start);
      document.removeEventListener('pointerdown', onGesture, { capture: true });
      document.removeEventListener('touchstart', onGesture, { capture: true });
    };
  }, [visible]);
  /* The starting split, once, so a parent that renders from it is not stale. */
  useEffect(() => { reportRef.current?.(posRef.current); }, []);

  const setFromClientX = useCallback((clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pct = ((clientX - r.left) / r.width) * 100;
    commitPos(Math.min(100, Math.max(0, pct)));
  }, [commitPos]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      e.preventDefault();
      setFromClientX(e.clientX);
    };
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
   * Follow the reader.
   *
   * Eased rather than snapped — about 12% of the remaining distance a frame —
   * so a hand crossing the page moves the divider like a slow wipe instead of
   * a flicker. The reading comes from the motion store (src/lib/stage-motion):
   * the pointer measured across the whole viewport on a desktop, so the split
   * keeps moving right to the edge of the page; the roll of the phone on a
   * phone. A drag or a keyboard step wins while it is happening: the
   * subscription is re-made with `dragging`, and a drag in progress ignores
   * the store entirely. Touch never drives it — the store ignores touch
   * pointers, and a finger on the stage is scrolling. The reading the store
   * replays on subscribing is skipped, so a drag that has just ended holds
   * where it was left until the reader moves again. `posRef` tracks the split
   * between React commits so consecutive frames do not read a stale value.
   */
  useEffect(() => {
    if (!motionDrive || dragging) return;
    let raf = 0;
    let target: number | null = null;
    let replay = true;

    const step = () => {
      raf = 0;
      if (target === null) return;
      const p = posRef.current;
      const next = Math.abs(target - p) < 0.06 ? target : p + (target - p) * 0.12;
      commitPos(next);
      if (next !== target) raf = requestAnimationFrame(step);
    };
    /* A pointer: the divider goes where the pointer is, measured across the
     * screen itself, so the whole travel is one edge of the phone to the
     * other — exactly as a drag would put it — and past either edge the
     * split simply holds at that end with one whole video showing. A
     * gyroscope: the phone's roll over the same travel. */
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
      if (replay) {
        replay = false;
        return;
      }
      if (m.source === 'none') return;
      target = targetFor(m);
      if (!raf) raf = requestAnimationFrame(step);
    });

    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
    };
  }, [motionDrive, dragging, commitPos]);

  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 3;
    if (e.key === 'ArrowLeft') { commitPos(Math.max(0, posRef.current - step)); e.preventDefault(); }
    if (e.key === 'ArrowRight') { commitPos(Math.min(100, posRef.current + step)); e.preventDefault(); }
    if (e.key === 'Home') { commitPos(0); e.preventDefault(); }
    if (e.key === 'End') { commitPos(100); e.preventDefault(); }
    /* A tick for each step; the steps themselves are as they were. */
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') play('tick');
  };

  /*
   * `preload="metadata"`, not "auto".
   *
   * These sit in the hero, so they start loading immediately. Asking the
   * browser to fetch both clips in full before it will consider the page loaded
   * pushed first paint out badly enough to stall the renderer — for decoration
   * that only matters once someone is actually looking at it. Metadata is
   * enough to size the element; autoplay then streams what it needs.
   */
  /*
   * Deliberately NOT autoPlay. Each element would start the moment it had
   * enough data, and the one that loaded first would be ahead by however long
   * the other took — an offset present from the very first frame that no drift
   * correction ever created and none of it could explain. The effect starts
   * both together once both can play; see the sync effect above.
   */

  return (
    <figure className="w-full">
      {/* The screen. `wrapRef` is the picture, so the drag maths measure it and
          not the frame Phone3D draws around it. `touch-action: pan-y` rather
          than `none`: a finger can still scroll the page over the phone, which
          on a phone is most of the viewport, and a sideways drag still moves
          the divider. The handle itself is `touch-none`, so a drag that starts
          on it is never taken for a scroll. */}
      <div
        ref={wrapRef}
        onPointerDown={(e) => {
          setDragging(true);
          setFromClientX(e.clientX);
        }}
        className="relative aspect-[9/16] w-full overflow-hidden rounded-[38px]
                   bg-panel select-none touch-pan-y"
      >
        {/*
          * The source. Off-screen but not `display:none` and not zero-sized —
          * a hidden element is allowed to be throttled or never decoded, and
          * the canvas would then have nothing to draw. It carries no poster of
          * its own: the still below is the composited one.
          */}
        {visible && (
          <video
            ref={videoRef}
            src={src}
            muted
            loop
            playsInline
            preload="auto"
            aria-hidden="true"
            className="pointer-events-none absolute h-px w-px opacity-0"
          />
        )}

        {/* The picture: both halves, from one frame, every frame. */}
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
          style={{ backgroundImage: `url(${poster})`, backgroundSize: 'cover' }}
        />

        {/* The divider: a hairline that goes out at either end, so a split
            pushed all the way shows one whole video with no line on it; and
            the handle, which stays on the screen at both ends so it can
            always be taken hold of and dragged back. */}
        <div
          className="pointer-events-none absolute inset-y-0 z-30 w-px bg-white/85
                     shadow-[0_0_12px_rgba(255,255,255,0.55)] transition-opacity duration-150"
          style={{ left: `${pos}%`, opacity: pos < 0.75 || pos > 99.25 ? 0 : 1 }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 z-30 w-0"
          style={{ left: `clamp(24px, ${pos}%, calc(100% - 24px))` }}
        >
          <div
            role="slider"
            tabIndex={0}
            aria-label="Compare uploaded normally against Pristine"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pos)}
            onKeyDown={onKey}
            className="pointer-events-auto touch-none absolute top-1/2 left-1/2 grid h-11 w-11 -translate-x-1/2
                       -translate-y-1/2 place-items-center rounded-full border border-white/30
                       bg-white/15 cursor-ew-resize
                       shadow-[0_10px_30px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.3)]
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <svg width="20" height="14" viewBox="0 0 20 14" fill="none" aria-hidden="true">
              <path d="M7.5 2 3 7l4.5 5M12.5 2 17 7l-4.5 5" stroke="white" strokeWidth="1.6"
                    strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </div>

      <figcaption className="mx-auto mt-9 max-w-[520px] text-center text-[12.5px] leading-relaxed text-dim">
        Both halves are exactly what TikTok served back — same footage, same account,
        uploaded minutes apart. They are delivered here as one file and drawn from the same
        frame, so the only difference you are looking at is what TikTok did to each.
      </figcaption>
    </figure>
  );
}
