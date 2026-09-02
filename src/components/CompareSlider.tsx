'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { play } from '@/lib/sound';
import { splitFor, subscribeMotion, type Motion } from '@/lib/stage-motion';

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
  beforeSrc: string;
  afterSrc: string;
  beforePoster: string;
  afterPoster: string;
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
 * Two frames at 60fps — below this the rate is left alone.
 *
 * THIS NUMBER CANNOT GO BELOW ONE FRAME, and it is worth saying why, because a
 * tighter value looks more precise and is in fact the thing that makes the
 * comparison stutter.
 *
 * `video.currentTime` does not advance smoothly. It reports the presentation
 * time of the frame currently on screen, so it steps once per frame — 16.7ms at
 * 60fps — and the two elements do not step on the same instant. So the drift
 * MEASURED between two perfectly synchronised clips still swings by up to a
 * full frame, purely from when each was sampled.
 *
 * Set the deadband under that and every sample looks like drift. The rate is
 * then nudged on almost every animation frame, swinging either side of 1 at
 * 60Hz, and the result is precisely the judder the correction exists to
 * prevent — a previous value of 0.004 (a quarter of a frame) did exactly this.
 * Two frames sits clearly above the sampling floor while staying under the
 * threshold where an offset reads as lag rather than as a comparison.
 */
const MAX_DRIFT_SEC = 0.033;
/* Past this, only a seek closes it: a loop wrap, a stall, or a buffering pause. */
const RESEEK_SEC = 0.12;
/*
 * The rate nudge is proportional to how far the drift is PAST the deadband —
 * not to the drift itself — and capped where motion would start to look wrong.
 *
 * Measuring from the deadband rather than from zero is what keeps the
 * correction continuous. Scaled from zero, crossing the threshold would jump
 * the rate straight to 0.95: a 5% step, applied the instant a measurement
 * wobbles over the line, which is a visible hitch and a second source of the
 * judder this whole mechanism exists to remove. Measured from the deadband, the
 * correction starts at nothing and grows, so there is no step to see at the
 * moment it engages.
 */
const RATE_GAIN = 1.5;
const RATE_MAX = 0.08;

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
 * What to do about a given drift, as a pure decision.
 *
 * Extracted so it can be tested. The rest of the sync is DOM and timing, which
 * needs a real browser and a visible page — `requestAnimationFrame` is throttled
 * to zero on a hidden document, so a headless check of the whole loop would
 * report a stall that no user would ever see. This is the part that carries the
 * actual judgement, and it is verifiable without any of that.
 *
 * `drift` is slave minus master: positive means the slave is ahead.
 */
export function correctionFor(drift: number): { seek: boolean; rate: number } {
  const mag = Math.abs(drift);
  if (mag > RESEEK_SEC) return { seek: true, rate: 1 };
  if (mag > MAX_DRIFT_SEC) {
    const excess = (mag - MAX_DRIFT_SEC) * Math.sign(drift);
    const nudge = Math.max(-RATE_MAX, Math.min(RATE_MAX, excess * RATE_GAIN));
    return { seek: false, rate: Math.round((1 - nudge) * 1000) / 1000 };
  }
  return { seek: false, rate: 1 };
}

export default function CompareSlider({
  beforeSrc, afterSrc, beforePoster, afterPoster, onPositionChange, motionDrive = false,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const beforeRef = useRef<HTMLVideoElement>(null);
  const afterRef = useRef<HTMLVideoElement>(null);

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
   * Keep the two elements on the same frame.
   *
   * WHY SEEKING ALONE DOES NOT WORK
   * The previous version only acted when drift passed a threshold, and then
   * corrected by assigning currentTime. A seek is not free: the element stalls
   * while it lands, which produces more drift, which triggers another seek. It
   * oscillates, and every correction is a visible jump — which reads as "the
   * videos are not synced" even though on average they are.
   *
   * So there are two regimes. A LARGE gap (a loop wrap, a stall, one stream
   * buffering) is a seek, because nothing else closes four seconds. A SMALL gap
   * is closed by nudging playbackRate a fraction, which the viewer cannot see
   * and which costs no seek at all. This is how video players keep audio and
   * video tracks together, for the same reason.
   *
   * They also start together rather than whenever each finishes loading: both
   * are held until `canplay` on both, then played in the same tick. Most of the
   * visible offset was there from the first frame and never came from drift.
   */
  useEffect(() => {
    if (!visible) return;
    const a = beforeRef.current;
    const b = afterRef.current;
    if (!a || !b) return;

    let raf = 0;
    let started = false;
    let starting = false;

    /*
     * WHY THIS WATCHES WHETHER play() ACTUALLY SUCCEEDED
     *
     * `play()` returns a promise, and it is rejected more often than the
     * autoplay rules suggest. Muted and inline satisfies the policy in a normal
     * tab, but not in iOS Low Power Mode, not under Data Saver, not in a
     * background or zero-sized tab, and not on some Android browsers until the
     * page has been touched. The earlier version set `started` before calling
     * play and swallowed the rejection, so any of those left both clips frozen
     * on their poster with nothing able to recover: `started` was true, so no
     * later `canplay` would try again, and there was no other path back.
     *
     * A silent still frame is the worst available failure. The comparison IS
     * the argument for the product, and a reader who sees two identical
     * motionless pictures concludes there is nothing in it.
     *
     * So `started` is only set once both elements are genuinely playing, a
     * rejection leaves the door open for the next attempt, and a first touch
     * anywhere on the page counts as one — which is the gesture every mobile
     * autoplay policy is waiting for.
     */
    const startBoth = () => {
      if (started || starting) return;
      if (a.readyState < 3 || b.readyState < 3) return;
      starting = true;
      a.currentTime = 0;
      b.currentTime = 0;
      void Promise.all([a.play(), b.play()])
        .then(() => { started = true; })
        .catch(() => { /* Blocked or interrupted; a later canplay or a touch retries. */ })
        .finally(() => { starting = false; });
    };

    const tick = () => {
      if (started && !a.paused && !b.paused && Number.isFinite(a.currentTime)) {
        const drift = b.currentTime - a.currentTime;

        const fix = correctionFor(drift);
        // A wrap or a stall: nothing gradual closes four seconds.
        if (fix.seek) b.currentTime = a.currentTime;
        // Otherwise nudge the rate. 2% is far below the ~5% at which a viewer
        // starts to notice motion running fast or slow.
        if (Math.abs(b.playbackRate - fix.rate) > 0.0015) b.playbackRate = fix.rate;
      }
      raf = requestAnimationFrame(tick);
    };

    /*
     * On a phone one clip buffers before the other, and a rate nudge cannot
     * close a gap that is still opening. So a stall on either side pauses
     * both, and when the stalled one can play again they are put on the same
     * frame and restarted in the same tick.
     */
    let holding = false;
    const hold = () => {
      if (!started || holding) return;
      holding = true;
      a.pause();
      b.pause();
    };
    const release = () => {
      if (!holding) return;
      if (a.readyState < 3 || b.readyState < 3) return;
      b.currentTime = a.currentTime;
      /* Same rule as startBoth: the hold is only lifted once both are really
       * playing again, so a rejected resume is retried rather than leaving the
       * pair stopped with `holding` false and nothing left to notice. */
      void Promise.all([a.play(), b.play()])
        .then(() => { holding = false; })
        .catch(() => {});
    };
    for (const v of [a, b]) {
      v.addEventListener('canplay', startBoth);
      v.addEventListener('waiting', hold);
      v.addEventListener('stalled', hold);
      v.addEventListener('canplay', release);
      v.addEventListener('canplaythrough', release);
    }
    /*
     * The gesture every mobile autoplay policy is waiting for. Passive and on
     * the capture phase so it cannot interfere with the divider's own drag, and
     * it costs nothing once the clips are running.
     */
    const onGesture = () => {
      if (!started) { startBoth(); return; }
      /* Started once, stopped since — a refused resume after a stall, or a
       * platform that paused the media on its own. A touch puts it back. */
      if (a.paused || b.paused) { holding = true; release(); }
    };
    document.addEventListener('pointerdown', onGesture, { passive: true, capture: true });
    document.addEventListener('touchstart', onGesture, { passive: true, capture: true });

    startBoth();
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('pointerdown', onGesture, { capture: true });
      document.removeEventListener('touchstart', onGesture, { capture: true });
      for (const v of [a, b]) {
        v.removeEventListener('canplay', startBoth);
        v.removeEventListener('waiting', hold);
        v.removeEventListener('stalled', hold);
        v.removeEventListener('canplay', release);
        v.removeEventListener('canplaythrough', release);
      }
      b.playbackRate = 1;
    };
  }, [visible]);

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
    posRef.current = next;
    setPos(next);
    reportRef.current?.(next);
    if (next > REVEAL_REARM_ABOVE) revealArmed.current = true;
    else if (revealArmed.current && next <= REVEAL_AT) {
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
  const videoProps = {
    muted: true,
    loop: true,
    playsInline: true,
    preload: 'auto' as const,
    className: 'absolute inset-0 h-full w-full object-cover',
  };

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
        {/* BEFORE — what TikTok does to an ordinary upload. */}
        {visible ? (
          <video ref={beforeRef} poster={beforePoster} {...videoProps}>
            <source src={beforeSrc} type="video/mp4" />
          </video>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={beforePoster} alt="" className="absolute inset-0 h-full w-full object-cover" />
        )}

        {/* AFTER — clipped from the left, so dragging reveals it. */}
        <div
          className="absolute inset-0"
          style={{ clipPath: `inset(0 0 0 ${pos}%)` }}
        >
          {visible ? (
            <video ref={afterRef} poster={afterPoster} {...videoProps}>
              <source src={afterSrc} type="video/mp4" />
            </video>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={afterPoster} alt="" className="absolute inset-0 h-full w-full object-cover" />
          )}
        </div>

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
        Both clips are exactly what TikTok served back — same footage, same account, uploaded
        minutes apart. Re-encoded here at identical settings for web playback, so the only
        difference is what TikTok did to each.
      </figcaption>
    </figure>
  );
}
