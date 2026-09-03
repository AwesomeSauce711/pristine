'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import PreviewCompare from '@/components/PreviewCompare';
import Stage from '@/components/Stage';
import { CRUSHED_STATS, PRISTINE_STATS, randomPristine } from '@/lib/engagement';

/*
 * The comparison on the landing page IS the tool page's preview.
 *
 * It used to be its own component: two real TikTok renditions welded into one
 * file, with a canvas reading both halves out of it. Every version of that was
 * fragile on a phone in a way the tool page's preview -- a visible <video> with
 * a small crushed copy drawn beside it -- never was, and the reader said so:
 * "it works with the file I upload". So this is that component, fed a bundled
 * clip, with the same phone, rail, headers and split it has on the tool page.
 *
 * WHAT THE CLIP IS
 * The right half is a Pristine-patched 4K60 upload -- 2160x3840, 60fps,
 * 22.8 Mbps, the file TikTok serves back byte for byte -- cut from its 4K
 * section and re-encoded to 1080x1920 for the web. The
 * crush is computed against the screen (see crushReduction), so a 1080-wide
 * file draws the identical 720/1080 reduction a 4K upload does: the left half
 * is that same footage at TikTok's measured delivery for an ordinary upload.
 * The caption says so. The figures in the screen's headers are the measured
 * ones; the engagement numbers are illustrative and labelled.
 */

/* The phone the tool page draws, so the two previews are the same object. */
const PREVIEW_WIDTH = 336;
const PREVIEW_ASPECT = 19.5 / 9;

/* A small deterministic PRNG (mulberry32), so server and client draw alike. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* What TikTok served for the patched upload the clip is cut from. */
const SERVED = { width: 2160, height: 3840, fps: 60, bitrateMbps: 22.8 };

interface Props {
  /** The pristine rendition, re-encoded for the web. */
  src: string;
  /** Draw the hand holding the phone. */
  hand?: boolean;
}

export default function CompareStage({ src, hand = true }: Props) {
  const [pos, setPos] = useState(50);
  const onPositionChange = useCallback((p: number) => setPos(p), []);

  /*
   * THE HINT. The split follows the pointer (or the tilt of a phone), and
   * nothing on the page said so: a reader who scrolled here saw one still
   * frame with a line down it. Each time the stage scrolls into view the
   * hint is shown over it until the reader does the thing it describes --
   * moves across the stage, or tilts -- after which it is not shown again.
   * The words fit the device: a cursor on a desktop, a finger or a tilt on
   * a phone.
   */
  const rootRef = useRef<HTMLElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [done, setDone] = useState(false);
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    /* Watch the hint's own band, not the whole stage: on a phone the stage
     * is taller than the screen and would never count as mostly visible. The
     * band is a few dozen pixels at the phone's middle; when all of it is on
     * screen, the reader is looking at the preview. */
    const el = hintRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    setCoarse(window.matchMedia('(pointer: coarse)').matches);
    const io = new IntersectionObserver(
      (entries) => setInView(entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.99)),
      { threshold: [0, 0.99, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (done || !inView) return;
    const el = rootRef.current;
    if (!el) return;
    const start = { x: -1, y: -1 };
    const finish = () => setDone(true);
    /* A cursor that has travelled some way across the stage, or a finger
     * that has dragged, or a phone that has tilted: any of these is the
     * reader having found it. */
    const onPointerMove = (e: PointerEvent) => {
      if (start.x < 0) { start.x = e.clientX; start.y = e.clientY; return; }
      if (Math.abs(e.clientX - start.x) > 80) finish();
    };
    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.gamma != null && Math.abs(e.gamma) > 12) finish();
    };
    el.addEventListener('pointermove', onPointerMove, { passive: true });
    el.addEventListener('pointerdown', finish, { passive: true });
    window.addEventListener('deviceorientation', onOrientation, { passive: true });
    return () => {
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerdown', finish);
      window.removeEventListener('deviceorientation', onOrientation);
    };
  }, [inView, done]);
  const hint = inView && !done;
  /* The million-scale figures, drawn from a FIXED seed.
   *
   * They used to be random per visit, which was safe while the only thing
   * showing them was the holograms, mounted after hydration. The preview's
   * engagement rail is server-rendered, so a random draw put one set of
   * numbers in the HTML and a different set on the client -- a hydration
   * mismatch (React #418) on every landing. The same seed on both sides makes
   * them agree; the tool page still draws a fresh set per file. */
  const [pristine] = useState(() => randomPristine(seeded(0x9e3779b9)));
  /* 0 at the crushed end of the travel (pos 100), 1 at the Pristine end. */
  const t = Math.min(1, Math.max(0, 1 - pos / 100));

  return (
    <figure ref={rootRef} className="relative w-full">
      <div
        ref={hintRef}
        aria-live="polite"
        className={`pointer-events-none absolute inset-x-0 top-[44%] z-30 flex justify-center px-6 transition-all duration-500 ease-out ${
          hint ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
        }`}
      >
        <span className="inline-flex items-center gap-2.5 rounded-full border border-white/15 bg-black/60 px-4 py-2 text-[13px] text-text shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur-md">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
            <path d="M3 12h18" /><path d="m7 8-4 4 4 4" /><path d="m17 8 4 4-4 4" />
          </svg>
          {coarse ? 'Drag across the video, or tilt your phone, to see the difference'
                  : 'Move your cursor left and right to see the difference'}
        </span>
      </div>
      <Stage
        t={t}
        hand={hand}
        aspect={PREVIEW_ASPECT}
        width={PREVIEW_WIDTH}
        pristine={pristine}
        illustrative
      >
        <PreviewCompare
          src={src}
          pristine={pristine}
          width={SERVED.width}
          height={SERVED.height}
          fps={SERVED.fps}
          bitrateMbps={SERVED.bitrateMbps}
          crushedLikes={CRUSHED_STATS.likes}
          pristineLikes={PRISTINE_STATS.likes}
          onPositionChange={onPositionChange}
          motionDrive
        />
      </Stage>
      <figcaption className="mx-auto mt-9 max-w-[560px] text-center text-[12.5px] leading-relaxed text-dim">
        The right half is a Pristine-patched 4K60 upload — 2160×3840, 60fps, 22.8 Mbps — the
        file TikTok serves back byte for byte. The left half is that same footage drawn at
        TikTok&rsquo;s measured delivery for an ordinary upload, 720×1280 at 2.9 Mbps — the same
        preview the tool shows for your own video. Engagement numbers are illustrative.
      </figcaption>
    </figure>
  );
}
