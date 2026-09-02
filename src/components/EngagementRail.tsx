'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import {
  compact, engagementAt, ENGAGEMENT_KEYS, CRUSHED_ENGAGEMENT, PRISTINE_ENGAGEMENT, type Engagement,
} from '@/lib/engagement';
import { play } from '@/lib/sound';

/*
 * The feed's right rail — heart, comment, bookmark, share — for the in-app
 * comparison.
 *
 * The landing page floats these out of the phone as holograms. In the tool the
 * phone is an instrument rather than a stage, so the same four numbers sit
 * where a feed actually puts them: a flat column down the right edge of the
 * post. What moves is the state, not the layout. As the handle travels toward
 * Pristine (`t` → 1) the counts climb, the icons come up from grey to their lit
 * colours, and crossing the midpoint pops them once — the way a tap does.
 *
 * WHY THE COLOUR IS BLENDED IN CSS
 * `t` changes on every pointer move, and each icon needs to sit somewhere
 * between unlit and lit for that value. Rather than mixing colours in JS every
 * frame, `--lit` is written once on the root and `color-mix()` does the blend,
 * with a short transition so a keyboard step glides instead of snapping.
 *
 * WHY THE BOUNCE USES THE WEB ANIMATIONS API
 * A CSS keyframe would have to live in globals.css and be restarted by toggling
 * a class. `element.animate()` is one call, transform-and-opacity only, runs on
 * the compositor, and is over when it is over — nothing to reset, and a second
 * crossing cannot leave a stale class behind.
 *
 * THE POP HAS A SOUND
 * The crossing plays `pop` (src/lib/sound.ts) — a bubble, the noise a tap
 * makes in a feed — on the same rule as the bounce, so a hand hovering on the
 * line does not rattle it. The sound survives reduced motion; the bounce does
 * not. Sound is not motion.
 *
 * NO FILTER ON THE ICONS
 * The icons carried a `drop-shadow` filter for legibility over the video. This
 * rail now sits on the stage, inside a 3D context, where a filter cannot be
 * composited on its own and costs the whole context a re-rasterisation every
 * frame (see Holograms.tsx). The halo under each icon and the counts'
 * text-shadow — neither is a filter — do the same job.
 *
 * The numbers are illustrative (src/lib/engagement.ts) and the caption under
 * the phone says so. The icons are generic paths drawn for this file; nothing
 * is copied from any platform.
 */

interface Props {
  /** How far toward Pristine: 0 is all crushed, 1 is all clean. */
  t: number;
  className?: string;
  /** The figures at the clean end; the tool draws a fresh set per file. */
  pristine?: Engagement;
}

/*
 * Icon paths on a 24-unit grid, with the colour each takes when lit. The
 * heart's red is the universal "liked" red; comment and share lift to plain
 * white; the bookmark takes the palette's amber.
 */
const ITEMS: Record<keyof Engagement, { d: string; lit: string; glow: string; glowMax: number }> = {
  likes: {
    d: 'M12 20.8 3.9 12.9a4.8 4.8 0 0 1 6.8-6.8l1.3 1.3 1.3-1.3a4.8 4.8 0 0 1 6.8 6.8Z',
    lit: '#fe2c55',
    glow: 'rgba(254, 44, 85, 0.65)',
    glowMax: 0.9,
  },
  comments: {
    d: 'M12 3.2C7 3.2 3 6.7 3 11c0 2.4 1.2 4.5 3.1 5.9L5.3 21l4.5-2.4c.7.1 1.4.2 2.2.2 5 0 9-3.5 9-7.8S17 3.2 12 3.2Z',
    lit: '#ffffff',
    glow: 'rgba(255, 255, 255, 0.55)',
    glowMax: 0.4,
  },
  bookmarks: {
    d: 'M6.5 3.5h11a1 1 0 0 1 1 1V21l-6.5-4-6.5 4V4.5a1 1 0 0 1 1-1Z',
    lit: 'var(--color-iri-amber, #ffb36b)',
    glow: 'rgba(255, 179, 107, 0.6)',
    glowMax: 0.8,
  },
  shares: {
    d: 'M13.5 4.5 21 11.2l-7.5 6.7v-4.1c-4.6.1-7.9 1.7-10.5 5.2.6-5.6 4-9.9 10.5-10.7V4.5Z',
    lit: '#ffffff',
    glow: 'rgba(255, 255, 255, 0.55)',
    glowMax: 0.4,
  },
};

/* Unlit: white well under full opacity, so a crushed post reads as ignored. */
const DIM_ICON = 'rgba(255, 255, 255, 0.42)';
const DIM_COUNT = 'rgba(255, 255, 255, 0.6)';

/*
 * The icons light over the first half of the travel — the same stretch where
 * engagementAt()'s ease-out does most of its climbing — so the colour arrives
 * with the numbers rather than after them, and is fully lit by the pop.
 */
const LIT_FROM = 0.08;
const LIT_TO = 0.5;
/* Pop once when the handle passes the midpoint toward Pristine... */
const POP_AT = 0.5;
/* ...and only again once it has come clearly back, so a hand hovering on the
 * line does not fire it every frame. */
const REARM_BELOW = 0.44;

const POP_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const POP: Keyframe[] = [
  { transform: 'scale(1)' },
  { transform: 'scale(1.24)', offset: 0.3 },
  { transform: 'scale(0.95)', offset: 0.62 },
  { transform: 'scale(1)' },
];
const RIPPLE: Keyframe[] = [
  { transform: 'scale(0.6)', opacity: 0.9 },
  { transform: 'scale(1.8)', opacity: 0 },
];

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const u = clamp01((x - e0) / (e1 - e0));
  return u * u * (3 - 2 * u);
}

export default function EngagementRail({ t, className, pristine }: Props) {
  const tt = clamp01(t);
  const stats = engagementAt(tt, CRUSHED_ENGAGEMENT, pristine ?? PRISTINE_ENGAGEMENT);
  const lit = smoothstep(LIT_FROM, LIT_TO, tt);

  const iconRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const ringRefs = useRef<(HTMLSpanElement | null)[]>([]);
  // Armed while the handle is at or below the line, so mounting past it does
  // not pop and the first drag across it does.
  const armed = useRef(tt <= POP_AT);

  useEffect(() => {
    if (tt < REARM_BELOW) armed.current = true;
    if (!armed.current || tt <= POP_AT) return;
    armed.current = false;
    play('pop');

    // Emphasis survives reduced motion (the colours still light); the pop does not.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const fire = (els: (HTMLSpanElement | null)[], frames: Keyframe[], duration: number) => {
      els.forEach((el, i) => {
        if (!el || typeof el.animate !== 'function') return;
        el.getAnimations().forEach((a) => a.cancel());
        el.animate(frames, { duration, delay: i * 70, easing: POP_EASE });
      });
    };
    fire(iconRefs.current, POP, 620);
    fire(ringRefs.current, RIPPLE, 760);
  }, [tt]);

  return (
    <div
      aria-hidden="true"
      className={['pointer-events-none flex flex-col items-center gap-3.5', className]
        .filter(Boolean)
        .join(' ')}
      style={{ '--lit': lit } as CSSProperties}
    >
      {ENGAGEMENT_KEYS.map((k, i) => {
        const it = ITEMS[k];
        return (
          <div key={k} className="flex flex-col items-center gap-1.5">
            <span className="relative grid h-10 w-10 place-items-center">
              {/* Halo in the icon's own colour; there only once lit. */}
              <span
                className="absolute -inset-2.5 rounded-full transition-opacity duration-150 ease-linear"
                style={{
                  background: `radial-gradient(circle, ${it.glow} 0%, transparent 68%)`,
                  opacity: `calc(var(--lit) * ${it.glowMax})`,
                }}
              />
              {/* Ripple ring for the pop; invisible until animated. */}
              <span
                ref={(el) => { ringRefs.current[i] = el; }}
                className="absolute inset-0 rounded-full border opacity-0"
                style={{ borderColor: it.lit }}
              />
              <span
                ref={(el) => { iconRefs.current[i] = el; }}
                className="relative transition-colors duration-150 ease-linear"
                style={{ color: `color-mix(in oklab, ${DIM_ICON}, ${it.lit} calc(var(--lit) * 100%))` }}
              >
                <svg
                  viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"
                  className="block"
                >
                  <path d={it.d} fill="currentColor" />
                </svg>
              </span>
            </span>
            <span
              className="tabular text-[11px] font-medium leading-none transition-colors duration-150 ease-linear
                         [text-shadow:0_1px_6px_rgba(0,0,0,0.6)]"
              style={{ color: `color-mix(in oklab, ${DIM_COUNT}, #ffffff calc(var(--lit) * 100%))` }}
            >
              {compact(stats[k])}
            </span>
          </div>
        );
      })}
    </div>
  );
}
