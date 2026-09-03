'use client';

import { useCallback, useState } from 'react';
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
 * The right half is exactly what TikTok served for a patched upload --
 * 2160x3840, 60fps, 41.7 Mbps -- re-encoded to 1080x1920 for the web. The
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
const SERVED = { width: 2160, height: 3840, fps: 60, bitrateMbps: 41.72 };

interface Props {
  /** The pristine rendition, re-encoded for the web. */
  src: string;
  /** Draw the hand holding the phone. */
  hand?: boolean;
}

export default function CompareStage({ src, hand = true }: Props) {
  const [pos, setPos] = useState(50);
  const onPositionChange = useCallback((p: number) => setPos(p), []);
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
    <figure className="w-full">
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
        The right half is exactly what TikTok served for a patched upload: 2160×3840, 60fps,
        41.7 Mbps. The left half is that same footage drawn at TikTok&rsquo;s measured delivery for
        an ordinary upload, 720×1280 at 30fps — the same preview the tool shows for your own
        video. Engagement numbers are illustrative.
      </figcaption>
    </figure>
  );
}
