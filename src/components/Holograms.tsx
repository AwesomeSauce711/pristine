'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import {
  compact, engagementAt, ENGAGEMENT_KEYS, CRUSHED_ENGAGEMENT, PRISTINE_ENGAGEMENT, type Engagement,
} from '@/lib/engagement';

/*
 * The four engagement figures, floating out of the phone.
 *
 * Likes, comments, bookmarks and shares as holographic cards standing in the
 * air above the screen. Each is lifted on its own translateZ inside the
 * stage's 3D context, with a plane of light standing between it and the
 * screen (a strip rotated ninety degrees about its top edge, so it runs from
 * the card back down to the glass) and a few motes drifting up out of it.
 *
 * `t` is how far the comparison has been pushed toward Pristine: 0 is all
 * crushed, 1 is all clean. As it rises the cards climb higher, brighten, and
 * their icons come up from grey to their lit colours; the counts follow
 * engagementAt(). Crossing the midpoint toward Pristine pops the icons once
 * and throws a burst of sparks — the way a tap does, with the bubble sound a
 * tap makes (src/lib/sound.ts) — and it re-arms only once the handle has come
 * clearly back, so a hand hovering on the line does not fire it every frame.
 * The sound is not motion, so it survives reduced motion; the pop does not.
 *
 * The cards are placed as percentages of the box this is mounted in — the
 * stage's overlay group, which is the phone's box — so they sit where they
 * sit at any width.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * No `filter`, no `mask`, no `backdrop-filter`. The first version had a
 * drop-shadow on each icon and a mask softening each beam's edges, and the
 * stage ran at two frames a second: inside a 3D rendering context a filter or
 * a mask cannot be composited on its own, so the browser re-rasterised the
 * whole context — videos included — every frame. Glow is a radial-gradient
 * halo, the beam's soft edges are drawn into its gradient, and the cards are
 * opaque glass. Only transform and opacity animate; the sparks sit hidden
 * (visibility, so they are never painted) until a burst throws them.
 *
 * The figures are illustrative (src/lib/engagement.ts) and the phone says so.
 * The icons are generic paths drawn for this site.
 */

interface Props {
  /** 0 = all crushed, 1 = all Pristine. */
  t: number;
  className?: string;
  /** The figures at the Pristine end; the stage draws a fresh set per visit. */
  pristine?: Engagement;
}

interface Item {
  d: string;
  /** Lit colour of the icon. */
  lit: string;
  /** "r,g,b" of the card's light. */
  glow: string;
  /** Position of the card's top-left, as a percentage of the phone box. */
  x: number;
  y: number;
  /** Height above the screen when fully lit, px. */
  z: number;
  /** Stagger for the motes, s. */
  delay: number;
}

const ITEMS: Record<keyof Engagement, Item> = {
  likes: {
    d: 'M12 20.8 3.9 12.9a4.8 4.8 0 0 1 6.8-6.8l1.3 1.3 1.3-1.3a4.8 4.8 0 0 1 6.8 6.8Z',
    lit: '#fe2c55',
    glow: '254,44,85',
    x: 58, y: 24, z: 150, delay: 0,
  },
  comments: {
    d: 'M12 3.2C7 3.2 3 6.7 3 11c0 2.4 1.2 4.5 3.1 5.9L5.3 21l4.5-2.4c.7.1 1.4.2 2.2.2 5 0 9-3.5 9-7.8S17 3.2 12 3.2Z',
    lit: '#ffffff',
    glow: '150,196,255',
    x: 74, y: 38, z: 105, delay: 0.8,
  },
  bookmarks: {
    d: 'M6.5 3.5h11a1 1 0 0 1 1 1V21l-6.5-4-6.5 4V4.5a1 1 0 0 1 1-1Z',
    lit: '#ffb36b',
    glow: '255,179,107',
    x: 56, y: 55, z: 125, delay: 1.5,
  },
  shares: {
    d: 'M13.5 4.5 21 11.2l-7.5 6.7v-4.1c-4.6.1-7.9 1.7-10.5 5.2.6-5.6 4-9.9 10.5-10.7V4.5Z',
    lit: '#ffffff',
    glow: '150,196,255',
    x: 76, y: 72, z: 85, delay: 2.2,
  },
};

const DIM_ICON = 'rgba(255, 255, 255, 0.45)';
const MOTES = 4;
const SPARKS = 10;

/* The icons light over the first half of the travel, where engagementAt()
 * does most of its climbing, so colour arrives with the numbers. */
const LIT_FROM = 0.08;
const LIT_TO = 0.5;
const POP_AT = 0.5;
const REARM_BELOW = 0.44;

const POP_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const POP: Keyframe[] = [
  { transform: 'scale(1)' },
  { transform: 'scale(1.3)', offset: 0.3 },
  { transform: 'scale(0.94)', offset: 0.62 },
  { transform: 'scale(1)' },
];

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const smoothstep = (e0: number, e1: number, x: number) => {
  const u = clamp01((x - e0) / (e1 - e0));
  return u * u * (3 - 2 * u);
};

export default function Holograms({ t, className, pristine }: Props) {
  const tt = clamp01(t);
  const stats = engagementAt(tt, CRUSHED_ENGAGEMENT, pristine ?? PRISTINE_ENGAGEMENT);
  const lit = smoothstep(LIT_FROM, LIT_TO, tt);

  const iconRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const sparkRefs = useRef<(HTMLSpanElement | null)[][]>([]);
  const armed = useRef(tt <= POP_AT);

  /* The pop and the burst, straight to the elements: nothing here is state.
   * Visual only: the split is a continuous control, and a sound on every
   * crossing rang dozens of times a session. */
  useEffect(() => {
    if (tt < REARM_BELOW) armed.current = true;
    if (!armed.current || tt <= POP_AT) return;
    armed.current = false;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    iconRefs.current.forEach((el, i) => {
      if (!el || typeof el.animate !== 'function') return;
      el.getAnimations().forEach((a) => a.cancel());
      el.animate(POP, { duration: 640, delay: i * 70, easing: POP_EASE });
    });
    sparkRefs.current.forEach((sparks, i) => {
      sparks.forEach((el, j) => {
        if (!el || typeof el.animate !== 'function') return;
        const angle = (j / SPARKS) * Math.PI * 2 + i * 0.4;
        const reach = 34 + (j % 3) * 14;
        el.getAnimations().forEach((a) => a.cancel());
        el.style.visibility = 'visible';
        const anim = el.animate(
          [
            { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
            {
              transform: `translate(calc(-50% + ${(Math.cos(angle) * reach).toFixed(1)}px), calc(-50% + ${(Math.sin(angle) * reach).toFixed(1)}px)) scale(0.2)`,
              opacity: 0,
            },
          ],
          { duration: 700, delay: i * 70, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
        );
        anim.onfinish = () => { el.style.visibility = 'hidden'; };
        anim.oncancel = () => { el.style.visibility = 'hidden'; };
      });
    });
  }, [tt]);

  return (
    <div
      aria-hidden="true"
      className={['pointer-events-none absolute', className].filter(Boolean).join(' ')}
      style={{ transformStyle: 'preserve-3d', '--lit': lit } as CSSProperties}
    >
      {ENGAGEMENT_KEYS.map((k, i) => {
        const it = ITEMS[k];
        /* Rises from a third of its height to its full height as t climbs. */
        const z = it.z * (0.34 + 0.66 * lit);
        const lift = -16 * lit;
        const icon = `color-mix(in oklab, ${DIM_ICON}, ${it.lit} calc(var(--lit) * 100%))`;
        return (
          <div
            key={k}
            className="absolute"
            /* Never further right than a card's width from the phone's edge,
               so on a narrow screen the cards stay inside the viewport. */
            style={{
              left: `min(${it.x}%, calc(100% - 150px))`,
              top: `${it.y}%`,
              transformStyle: 'preserve-3d',
            }}
          >
            {/* The plane of light between the screen and the card. It hangs
                from the card's bottom edge and is turned back ninety degrees,
                so its far end lands on the glass. Its soft sides are in the
                gradient itself: brightest down the middle, clear at the edges. */}
            <div
              className="absolute left-1/2 top-full w-12"
              style={{
                height: z,
                transform: `translate3d(-50%, ${lift}px, ${z}px) rotateX(-90deg)`,
                transformOrigin: 'top center',
                background:
                  `radial-gradient(60% 100% at 50% 100%, rgba(${it.glow}, ${(0.12 + 0.3 * lit).toFixed(3)}), ` +
                  `rgba(${it.glow}, ${(0.04 + 0.08 * lit).toFixed(3)}) 45%, rgba(${it.glow}, 0) 100%)`,
                transition: 'transform 220ms ease-out, height 220ms ease-out',
              }}
            />

            <div
              className="relative rounded-2xl border"
              style={{
                transform: `translate3d(0, ${lift}px, ${z}px)`,
                opacity: 0.45 + 0.55 * lit,
                /* A hologram: the card is light, not a slab — a tinted glass
                 * you can see the picture through, its rim and its glow in
                 * the icon's colour. */
                borderColor: `rgba(${it.glow}, ${(0.25 + 0.45 * lit).toFixed(3)})`,
                background:
                  `linear-gradient(180deg, rgba(${it.glow}, ${(0.1 + 0.12 * lit).toFixed(3)}), ` +
                  `rgba(${it.glow}, ${(0.03 + 0.05 * lit).toFixed(3)}))`,
                boxShadow:
                  `0 0 ${(12 + 30 * lit).toFixed(0)}px rgba(${it.glow}, ${(0.45 * lit).toFixed(3)}), ` +
                  `inset 0 0 18px rgba(${it.glow}, ${(0.12 + 0.18 * lit).toFixed(3)}), ` +
                  'inset 0 1px 0 rgba(255, 255, 255, 0.22)',
                transition: 'transform 220ms ease-out, opacity 220ms ease-out, box-shadow 220ms ease-out',
              }}
            >
              <div className="holo-float relative flex items-center gap-2.5 px-3.5 py-2.5">
                <span className="relative grid h-7 w-7 place-items-center">
                  {/* The icon's halo: a gradient, not a filter. */}
                  <span
                    className="absolute -inset-2 rounded-full"
                    style={{
                      background: `radial-gradient(circle, rgba(${it.glow}, 0.55) 0%, rgba(${it.glow}, 0) 70%)`,
                      opacity: lit,
                    }}
                  />
                  <span
                    ref={(el) => { iconRefs.current[i] = el; }}
                    className="relative block"
                    style={{ color: icon }}
                  >
                    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
                      <path d={it.d} fill="currentColor" />
                    </svg>
                  </span>
                </span>
                <span
                  className="tabular text-[14px] font-semibold leading-none text-white"
                  style={{ textShadow: `0 0 10px rgba(${it.glow}, 0.9), 0 1px 2px rgba(0,0,0,0.6)` }}
                >
                  {compact(stats[k])}
                </span>
              </div>

              {/* Motes drifting up out of the card; only there once lit. */}
              {Array.from({ length: MOTES }, (_, j) => (
                <span
                  key={j}
                  className="holo-particle"
                  style={{
                    left: `${14 + j * 22}%`,
                    bottom: '30%',
                    color: it.lit,
                    opacity: lit,
                    animationDelay: `${(j * 0.8 + it.delay).toFixed(2)}s`,
                    '--drift': `${(j % 2 ? 1 : -1) * (4 + j * 3)}px`,
                  } as CSSProperties}
                />
              ))}

              {/* Sparks for the pop; hidden, and so never painted, until thrown. */}
              {Array.from({ length: SPARKS }, (_, j) => (
                <span
                  key={j}
                  ref={(el) => {
                    (sparkRefs.current[i] ??= [])[j] = el;
                  }}
                  className="absolute left-1/2 top-1/2 h-1.5 w-1.5 rounded-full"
                  style={{
                    visibility: 'hidden',
                    opacity: 0,
                    transform: 'translate(-50%, -50%)',
                    background: j % 3 === 0 ? '#fff' : it.lit,
                    boxShadow: `0 0 6px rgba(${it.glow}, 0.9)`,
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
