'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
 * Deliberately generic chrome — no TikTok logo, wordmark or copied iconography.
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
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString('en-US');
}

const Heart = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" className={className}>
    <path d="M12 20.8 3.9 12.9a4.8 4.8 0 0 1 6.8-6.8l1.3 1.3 1.3-1.3a4.8 4.8 0 0 1 6.8 6.8Z" fill="currentColor" />
  </svg>
);

export default function PreviewCompare({
  src, width, height, fps, bitrateMbps,
  crushedLikes, pristineLikes,
  handle = '@yourhandle',
  sound = 'original sound — your edit',
  targetShortEdge = 720, targetFps = 30,
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

    let raf = 0;
    let lastDrawn = -1;
    const interval = 1 / targetFps;

    const size = () => {
      if (!v.videoWidth) return;
      const shortEdge = Math.min(v.videoWidth, v.videoHeight);
      // The reduction TikTok actually applies, as a factor. Never above 1: if the
      // source is already below the rung, claiming it gets worse would be a lie
      // in our own favour.
      const reduction = Math.min(1, targetShortEdge / shortEdge);
      const displayW = wrap.clientWidth || 300;
      const aspect = v.videoHeight / v.videoWidth;
      // Apply that same factor to the size actually on screen, so the visible
      // detail loss matches the real one instead of being hidden by the fact that
      // a phone mock is smaller than a phone.
      c.width = Math.max(16, Math.round(displayW * reduction));
      c.height = Math.max(16, Math.round(displayW * reduction * aspect));
    };

    const draw = () => {
      if (v.readyState >= 2) {
        const due = lastDrawn < 0
          || v.currentTime - lastDrawn >= interval
          || v.currentTime < lastDrawn;
        if (due && c.width > 0) {
          lastDrawn = v.currentTime;
          ctx.drawImage(v, 0, 0, c.width, c.height);
        }
      }
      raf = requestAnimationFrame(draw);
    };

    v.addEventListener('loadedmetadata', size);
    if (v.videoWidth) size();
    const ro = new ResizeObserver(size);
    ro.observe(wrap);

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      v.removeEventListener('loadedmetadata', size);
    };
  }, [src, targetShortEdge, targetFps]);

  const setFromClientX = useCallback((clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  }, []);

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

  const crushedSpec = `${Math.round(targetShortEdge)}×${Math.round(targetShortEdge * (height / width))} · ${targetFps}fps`;
  const pristineSpec = `${width}×${height} · ${fps.toFixed(0)}fps · ${bitrateMbps.toFixed(1)} Mbps`;

  return (
    <div className="mx-auto w-full max-w-[320px]">
      <div
        ref={wrapRef}
        onPointerDown={(e) => { setDragging(true); setFromClientX(e.clientX); }}
        className="relative aspect-[9/19.5] w-full touch-none select-none overflow-hidden
                   rounded-[32px] border border-line bg-black shadow-2xl"
      >
        {/* Clean side — the video itself. One element, one clock. */}
        <video
          ref={videoRef}
          src={src}
          muted loop playsInline autoPlay
          className="absolute inset-0 h-full w-full object-cover"
        />

        {/* Crushed side, clipped to the left of the handle. */}
        <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full object-cover"
            style={{ imageRendering: 'auto', filter: 'saturate(.8) contrast(.93) brightness(.94)' }}
          />
        </div>

        {/* Legibility wash, top and bottom, over both halves. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/65 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/80 to-transparent" />

        {/* ---- headers: always both visible, so the comparison reads at a glance ---- */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-between gap-2 p-3">
          <div className="max-w-[46%]">
            <div className="legend text-[8.5px] leading-tight text-white/55">Without Pristine</div>
            <div className="tabular mt-1 text-[9.5px] leading-tight text-white/75">{crushedSpec}</div>
          </div>
          <div className="max-w-[52%] text-right">
            <div className="legend text-[8.5px] leading-tight text-accent-soft">With Pristine</div>
            <div className="tabular mt-1 text-[9.5px] font-medium leading-tight text-white">{pristineSpec}</div>
          </div>
        </div>

        {/* ---- like counters: one per side, red on the good one ---- */}
        <div className="pointer-events-none absolute bottom-32 left-3 flex flex-col items-center gap-1 text-white/45">
          <Heart />
          <span className="tabular text-[11px] leading-none">{compact(crushedLikes)}</span>
        </div>
        <div className="pointer-events-none absolute right-3 bottom-32 flex flex-col items-center gap-1">
          <Heart className="text-[#fe2c55] drop-shadow-[0_0_10px_rgba(254,44,85,0.55)]" />
          <span className="tabular text-[12px] font-semibold leading-none text-white">
            {compact(pristineLikes)}
          </span>
        </div>

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

        {/* ---- handle ---- */}
        <div className="pointer-events-none absolute inset-y-0" style={{ left: `${pos}%` }}>
          <div className="absolute inset-y-0 -left-px w-0.5 bg-white/90" />
          <div className="absolute top-1/2 -left-[18px] grid h-9 w-9 -translate-y-1/2 place-items-center
                          rounded-full bg-white text-black shadow-lg">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M9.5 7.5 5 12l4.5 4.5M14.5 7.5 19 12l-4.5 4.5" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </div>
        </div>

        <input
          type="range" min={0} max={100} value={Math.round(pos)}
          onChange={(e) => setPos(Number(e.target.value))}
          aria-label="Compare an ordinary upload with Pristine"
          className="absolute inset-x-0 bottom-0 h-10 w-full cursor-ew-resize opacity-0"
        />
      </div>

      <p className="mt-4 text-center text-[11.5px] leading-relaxed text-dim">
        Drag to compare. Like counts are illustrative.
      </p>
    </div>
  );
}
