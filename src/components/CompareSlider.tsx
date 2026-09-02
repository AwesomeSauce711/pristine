'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
 */

interface Props {
  beforeSrc: string;
  afterSrc: string;
  beforePoster: string;
  afterPoster: string;
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
/* Half a frame of the 30fps side — below this, nobody can tell. */
const MAX_DRIFT_SEC = 0.017;
/* Past this, only a seek closes it: a loop wrap, a stall, or a buffering pause. */
const RESEEK_SEC = 0.25;

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
  if (mag > MAX_DRIFT_SEC) return { seek: false, rate: drift > 0 ? 0.98 : 1.02 };
  return { seek: false, rate: 1 };
}

export default function CompareSlider({ beforeSrc, afterSrc, beforePoster, afterPoster }: Props) {
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

    const startBoth = () => {
      if (started) return;
      if (a.readyState < 3 || b.readyState < 3) return;
      started = true;
      a.currentTime = 0;
      b.currentTime = 0;
      void a.play().catch(() => {});
      void b.play().catch(() => {});
    };

    const tick = () => {
      if (started && !a.paused && !b.paused && Number.isFinite(a.currentTime)) {
        const drift = b.currentTime - a.currentTime;

        const fix = correctionFor(drift);
        // A wrap or a stall: nothing gradual closes four seconds.
        if (fix.seek) b.currentTime = a.currentTime;
        // Otherwise nudge the rate. 2% is far below the ~5% at which a viewer
        // starts to notice motion running fast or slow.
        if (b.playbackRate !== fix.rate) b.playbackRate = fix.rate;
      }
      raf = requestAnimationFrame(tick);
    };

    a.addEventListener('canplay', startBoth);
    b.addEventListener('canplay', startBoth);
    startBoth();
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      a.removeEventListener('canplay', startBoth);
      b.removeEventListener('canplay', startBoth);
      b.playbackRate = 1;
    };
  }, [visible]);

  const setFromClientX = useCallback((clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pct = ((clientX - r.left) / r.width) * 100;
    setPos(Math.min(98, Math.max(2, pct)));
  }, []);

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

  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 3;
    if (e.key === 'ArrowLeft') { setPos((p) => Math.max(2, p - step)); e.preventDefault(); }
    if (e.key === 'ArrowRight') { setPos((p) => Math.min(98, p + step)); e.preventDefault(); }
    if (e.key === 'Home') { setPos(2); e.preventDefault(); }
    if (e.key === 'End') { setPos(98); e.preventDefault(); }
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
      <div
        ref={wrapRef}
        onPointerDown={(e) => {
          setDragging(true);
          setFromClientX(e.clientX);
        }}
        className="relative aspect-[9/16] w-full max-w-[380px] mx-auto overflow-hidden rounded-[20px]
                   border border-line bg-panel select-none touch-none
                   shadow-[0_30px_90px_-30px_rgba(0,0,0,0.9)]"
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

        {/* Corner badges. Figures are the delivered ones, not the uploaded ones. */}
        <div
          className="absolute left-3 top-3 z-20 rounded-lg border border-white/10 bg-black/65
                     px-2.5 py-1.5 backdrop-blur-sm transition-opacity"
          style={{ opacity: pos > 22 ? 1 : 0 }}
        >
          <div className="legend text-[9px] text-white/45">Uploaded normally</div>
          <div className="tabular text-[11px] font-medium text-white/90">720×1280 · 30fps</div>
          <div className="tabular text-[10px] text-white/50">2.90 Mbps</div>
        </div>

        <div
          className="absolute right-3 top-3 z-20 rounded-lg border border-accent/30 bg-black/65
                     px-2.5 py-1.5 backdrop-blur-sm transition-opacity"
          style={{ opacity: pos < 78 ? 1 : 0 }}
        >
          <div className="legend text-[9px] text-accent-soft">With Pristine</div>
          <div className="tabular text-[11px] font-medium text-white/90">2160×3840 · 60fps</div>
          <div className="tabular text-[10px] text-white/50">41.72 Mbps</div>
        </div>

        {/* The divider. */}
        <div
          className="pointer-events-none absolute inset-y-0 z-30 w-px bg-white/85"
          style={{ left: `${pos}%` }}
        >
          <div
            role="slider"
            tabIndex={0}
            aria-label="Compare uploaded normally against Pristine"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pos)}
            onKeyDown={onKey}
            className="pointer-events-auto absolute top-1/2 left-1/2 grid h-11 w-11 -translate-x-1/2
                       -translate-y-1/2 place-items-center rounded-full border border-white/25
                       bg-black/70 backdrop-blur-sm cursor-ew-resize
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <svg width="20" height="14" viewBox="0 0 20 14" fill="none" aria-hidden="true">
              <path d="M7.5 2 3 7l4.5 5M12.5 2 17 7l-4.5 5" stroke="white" strokeWidth="1.6"
                    strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </div>

      <figcaption className="mx-auto mt-4 max-w-[520px] text-center text-[12.5px] leading-relaxed text-dim">
        Both clips are exactly what TikTok served back — same footage, same account, uploaded
        minutes apart. Re-encoded here at identical settings for web playback, so the only
        difference is what TikTok did to each.
      </figcaption>
    </figure>
  );
}
