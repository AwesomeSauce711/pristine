'use client';

import { memo, useState, type CSSProperties } from 'react';

/*
 * The bloom: glowing hearts, comments, saves and shares that come up in the
 * background as the comparison is pushed toward Pristine, and go again as it
 * is pushed back. No figures — the holograms and the rail carry the numbers;
 * this is the feeling of a post taking off, drawn behind the phone.
 *
 * HOW IT FOLLOWS THE SPLIT
 * Each icon has a threshold `k` between 0 and 1. It is unlit below `k`, and
 * fades and grows in over the next 0.18 of `t`, so the field fills from the
 * first crossing to the far end rather than switching on all at once, and
 * empties the same way in reverse. The thresholds are spread so the first
 * few appear early and the crowd arrives late. A short CSS transition on
 * opacity and transform smooths the per-frame updates a drag produces.
 *
 * WHERE THEY SIT
 * In two bands either side of the phone, over the full height of the stage,
 * plus a handful across the top. On a narrow screen the bands run under the
 * phone's edges, and the phone simply covers them: this layer is painted
 * under the column (it comes before it in the stage, with no z-index).
 *
 * NO FILTER
 * The glow is a radial-gradient halo behind each icon, never a drop-shadow —
 * the rule for every layer near the videos. Only transform and opacity ever
 * change. Positions are drawn once per mount, on the client (the stage only
 * mounts this once it is in view, after hydration).
 */

interface Props {
  /** 0 = all crushed, 1 = all Pristine. */
  t: number;
  className?: string;
}

type Kind = 'heart' | 'comment' | 'bookmark' | 'share';

const PATHS: Record<Kind, string> = {
  heart: 'M12 20.8 3.9 12.9a4.8 4.8 0 0 1 6.8-6.8l1.3 1.3 1.3-1.3a4.8 4.8 0 0 1 6.8 6.8Z',
  comment: 'M12 3.2C7 3.2 3 6.7 3 11c0 2.4 1.2 4.5 3.1 5.9L5.3 21l4.5-2.4c.7.1 1.4.2 2.2.2 5 0 9-3.5 9-7.8S17 3.2 12 3.2Z',
  bookmark: 'M6.5 3.5h11a1 1 0 0 1 1 1V21l-6.5-4-6.5 4V4.5a1 1 0 0 1 1-1Z',
  share: 'M13.5 4.5 21 11.2l-7.5 6.7v-4.1c-4.6.1-7.9 1.7-10.5 5.2.6-5.6 4-9.9 10.5-10.7V4.5Z',
};

/* Lit colour and "r,g,b" of the halo. */
const LOOK: Record<Kind, { fill: string; glow: string }> = {
  heart: { fill: '#ff5c8a', glow: '254,44,85' },
  comment: { fill: '#8fe8ff', glow: '78,240,255' },
  bookmark: { fill: '#ffc36b', glow: '255,179,107' },
  share: { fill: '#9db8ff', glow: '91,140,255' },
};

/* Hearts most, then comments, then saves and shares. */
const KINDS: Kind[] = [
  'heart', 'heart', 'heart', 'heart', 'comment', 'comment', 'bookmark', 'share',
];

const COUNT = 30;
/* Fewer on a phone: half the icons, each still fading with the split. */
const COUNT_NARROW = 14;
/* How much of `t` an icon takes to come fully up once its threshold is passed. */
const RAMP = 0.18;

interface Icon {
  kind: Kind;
  /** Percent of the layer. */
  x: number;
  y: number;
  /** px */
  size: number;
  k: number;
  /** Float period and phase, seconds. */
  dur: number;
  delay: number;
  rot: number;
}

function scatter(): Icon[] {
  const out: Icon[] = [];
  const n = typeof window !== 'undefined' && window.innerWidth < 700 ? COUNT_NARROW : COUNT;
  for (let i = 0; i < n; i++) {
    const r = Math.random;
    /* Left band, right band, or (one in five) across the top. */
    const roll = r();
    let x: number;
    let y: number;
    if (roll < 0.4) { x = 2 + r() * 26; y = 4 + r() * 92; }
    else if (roll < 0.8) { x = 72 + r() * 26; y = 4 + r() * 92; }
    else { x = 20 + r() * 60; y = -2 + r() * 14; }
    out.push({
      kind: KINDS[Math.floor(r() * KINDS.length)],
      x,
      y,
      size: 14 + r() * 22,
      /* Spread so a few come early and most arrive late. */
      k: Math.pow(r(), 0.8) * (1 - RAMP),
      dur: 5 + r() * 5,
      delay: -r() * 8,
      rot: (r() - 0.5) * 30,
    });
  }
  return out;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (v: number) => v * v * (3 - 2 * v);

function EngagementBloom({ t, className }: Props) {
  const [icons] = useState(scatter);
  const tt = clamp01(t);

  return (
    <div
      aria-hidden
      className={['pointer-events-none absolute inset-0 overflow-hidden', className].filter(Boolean).join(' ')}
    >
      {icons.map((ic, i) => {
        const a = smooth(clamp01((tt - ic.k) / RAMP));
        const look = LOOK[ic.kind];
        const style: CSSProperties = {
          left: `${ic.x}%`,
          top: `${ic.y}%`,
          width: ic.size,
          height: ic.size,
          opacity: a,
          transform: `translate(-50%, -50%) rotate(${ic.rot}deg) scale(${0.55 + 0.45 * a})`,
          '--bloom-dur': `${ic.dur}s`,
          '--bloom-delay': `${ic.delay}s`,
        } as CSSProperties;
        return (
          <div key={i} className="bloom-icon absolute" style={style}>
            <div
              className="bloom-halo absolute rounded-full"
              style={{
                inset: '-90%',
                background: `radial-gradient(circle, rgba(${look.glow},0.55) 0%, rgba(${look.glow},0.18) 38%, transparent 68%)`,
              }}
            />
            <svg viewBox="0 0 24 24" width="100%" height="100%" className="bloom-shape relative">
              <path d={PATHS[ic.kind]} fill={look.fill} />
            </svg>
          </div>
        );
      })}
    </div>
  );
}

/* Memoised: the stage re-renders on every frame of a drag, and the bloom
 * only needs to when its (quantised) t has moved. */
export default memo(EngagementBloom);
