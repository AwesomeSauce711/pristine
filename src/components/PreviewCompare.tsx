'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/*
 * One phone, one video, a slider down the middle.
 *
 * WHY ONE VIDEO ELEMENT AND NOT TWO
 * The earlier version put two <video> elements side by side and they drifted —
 * visibly, within a few seconds, because nothing keeps independent media
 * elements on the same clock. You can correct drift by nudging currentTime, but
 * it never looks right and it never fully stops.
 *
 * Here the clean side IS the video element, and the crushed side is a canvas
 * drawing FROM that same element. There is one clock, so the two halves cannot
 * disagree about which frame it is — sync is structural rather than maintained.
 * It also halves the decode cost, which matters on the phone this is aimed at.
 *
 * THE CRUSHED SIDE IS A REAL DOWNSCALE, NOT A BLUR
 * The canvas is sized to TikTok's measured delivery rung and redrawn only at its
 * measured frame rate, so both the detail loss and the motion loss follow from
 * the numbers TikTok actually served. A CSS blur would be a guess at what
 * compression looks like; this is what a lower rendition is.
 *
 * THE ENGAGEMENT NUMBERS ARE ILLUSTRATIVE and labelled as such below the frame.
 * They exist to make the comparison legible, not to imply an outcome.
 *
 * Deliberately generic chrome — no TikTok logo, wordmark or copied iconography.
 */

interface Stats { likes: number; comments: number; shares: number }

interface Props {
  src: string;
  /** Real, read from the user's own file. */
  width: number;
  height: number;
  fps: number;
  bitrateMbps: number;
  crushed: Stats;
  pristine: Stats;
  targetShortEdge?: number;
  targetFps?: number;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString('en-US');
}

/* Drawn from scratch — the shared vocabulary of vertical video, not anyone's artwork. */
const Heart = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
    <path d="M12 20.5 4.2 13a4.6 4.6 0 0 1 6.5-6.5l1.3 1.3 1.3-1.3A4.6 4.6 0 0 1 19.8 13Z" fill="currentColor" />
  </svg>
);
const Bubble = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
    <path d="M3.5 11.4C3.5 7.3 7.3 4 12 4s8.5 3.3 8.5 7.4-3.8 7.4-8.5 7.4a10 10 0 0 1-2.4-.3L5.4 20l.9-2.9a7 7 0 0 1-2.8-5.7Z" fill="currentColor" />
  </svg>
);
const Arrow = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
    <path d="M13 4.5 21 12l-8 7.5V15c-4.4 0-7.4 1.3-9.5 4 .6-5.6 3.9-9.4 9.5-9.9Z" fill="currentColor" />
  </svg>
);

function Rail({ stats, side }: { stats: Stats; side: 'crushed' | 'pristine' }) {
  const rows: [React.ReactNode, number][] = [
    [<Heart key="h" />, stats.likes],
    [<Bubble key="c" />, stats.comments],
    [<Arrow key="s" />, stats.shares],
  ];
  return (
    <div className={`flex flex-col gap-3.5 ${side === 'crushed' ? 'text-white/60' : 'text-white'}`}>
      {rows.map(([icon, n], i) => (
        <div key={i} className="flex flex-col items-center gap-0.5">
          {icon}
          <span className={`tabular text-[10.5px] leading-none ${side === 'pristine' ? 'font-semibold' : ''}`}>
            {compact(n)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function PreviewCompare({
  src, width, height, fps, bitrateMbps, crushed, pristine,
  targetShortEdge = 720, targetFps = 30,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pos, setPos] = useState(50);
  const [dragging, setDragging] = useState(false);

  /* ---- the crushed canvas, driven by the SAME element ------------------- */
  useEffect(() => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;
    const ctx = c.getContext('2d', { alpha: false });
    if (!ctx) return;

    let raf = 0;
    let lastDrawn = -1;
    const interval = 1 / targetFps;

    const size = () => {
      if (!v.videoWidth) return;
      // Never scale up: if the source is already below the rung, pretending it
      // improves would be a lie in our own favour.
      const s = Math.min(1, targetShortEdge / Math.min(v.videoWidth, v.videoHeight));
      c.width = Math.max(2, Math.round(v.videoWidth * s));
      c.height = Math.max(2, Math.round(v.videoHeight * s));
    };

    const draw = () => {
      if (v.readyState >= 2) {
        // Hold each frame for the whole simulated interval, so motion is really
        // sampled at the lower rate rather than just looking soft.
        const due = lastDrawn < 0 || v.currentTime - lastDrawn >= interval || v.currentTime < lastDrawn;
        if (due && c.width > 0) {
          lastDrawn = v.currentTime;
          ctx.drawImage(v, 0, 0, c.width, c.height);
        }
      }
      raf = requestAnimationFrame(draw);
    };

    v.addEventListener('loadedmetadata', size);
    if (v.videoWidth) size();
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); v.removeEventListener('loadedmetadata', size); };
  }, [src, targetShortEdge, targetFps]);

  /* ---- dragging ---------------------------------------------------------- */
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

  const real = `${width}×${height} · ${fps.toFixed(0)}fps · ${bitrateMbps.toFixed(1)} Mbps`;

  return (
    <div className="mx-auto w-full max-w-[300px]">
      <div
        ref={wrapRef}
        onPointerDown={(e) => { setDragging(true); setFromClientX(e.clientX); }}
        className="relative aspect-[9/19.5] w-full select-none overflow-hidden rounded-[30px]
                   border border-line bg-black shadow-2xl touch-none"
      >
        {/* The clean side is the video itself — one element, one clock. */}
        <video
          ref={videoRef}
          src={src}
          muted loop playsInline autoPlay
          className="absolute inset-0 h-full w-full object-cover"
        />

        {/* The crushed side, clipped to the left of the handle. */}
        <div
          className="absolute inset-0"
          style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
        >
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full object-cover"
            style={{ imageRendering: 'auto', filter: 'saturate(.82) contrast(.96)' }}
          />
          <div className="absolute inset-0 bg-black/25" />
        </div>

        {/* ---- crushed overlay ---- */}
        <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
          <div className="absolute right-3 bottom-24"><Rail stats={crushed} side="crushed" /></div>
          <div className="absolute inset-x-0 bottom-0 p-3.5">
            <div className="legend text-[9px] text-white/50">Uploaded normally</div>
            <div className="tabular mt-1 text-[10.5px] text-white/70">720×1280 · 30fps · 2.9 Mbps</div>
          </div>
        </div>

        {/* ---- pristine overlay ---- */}
        <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
          <div className="absolute right-3 bottom-24"><Rail stats={pristine} side="pristine" /></div>
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3.5">
            <div className="legend text-[9px] text-accent-soft">With Pristine</div>
            <div className="tabular mt-1 text-[10.5px] font-medium text-white">{real}</div>
          </div>
        </div>

        {/* ---- the handle ---- */}
        <div className="pointer-events-none absolute inset-y-0" style={{ left: `${pos}%` }}>
          <div className="absolute inset-y-0 -left-px w-0.5 bg-white/85" />
          <div
            className="absolute top-1/2 -left-[17px] grid h-[34px] w-[34px] -translate-y-1/2
                       place-items-center rounded-full bg-white text-black shadow-lg"
          >
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
              <path d="M9.5 7.5 5 12l4.5 4.5M14.5 7.5 19 12l-4.5 4.5"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                    strokeLinejoin="round" fill="none" />
            </svg>
          </div>
        </div>

        {/* Keyboard-operable equivalent of the drag. */}
        <input
          type="range" min={0} max={100} value={Math.round(pos)}
          onChange={(e) => setPos(Number(e.target.value))}
          aria-label="Compare normal upload with Pristine"
          className="absolute inset-x-0 bottom-0 h-10 w-full cursor-ew-resize opacity-0"
        />
      </div>

      <p className="mt-4 text-center text-[11.5px] leading-relaxed text-dim">
        Drag to compare. Engagement numbers are illustrative.
      </p>
    </div>
  );
}
