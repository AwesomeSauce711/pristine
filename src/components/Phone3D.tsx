'use client';

import type { CSSProperties, ReactNode } from 'react';

/*
 * The phone every phone on the site is: a body with real thickness.
 *
 * Round one drew the frame flat — a rounded bezel with a hairline and a ring —
 * and let the tilt sell the rest. Turned fourteen degrees it read as a card.
 * This is a box: the front bezel at z = 0, four side faces standing back from
 * it (each a thin slab hung just outside an edge of the bezel and turned
 * ninety degrees about that edge, its lit side out, shaded darker toward the
 * back), and a back plate closing it fourteen pixels behind. Turn it and the
 * near side appears, exactly as thick as it should be, because the browser is
 * projecting a solid and not a drawing of one. The slabs' positions, turns and
 * materials are the `.phone-face-*` classes in globals.css — complete on their
 * own, so the geometry has one home — and this file adds only the box they
 * stand in and the parts that move with `t`.
 *
 * THE RING IS NOT A MASK
 * Round one painted the iridescent rim by masking a gradient down to its own
 * padding. A mask inside a 3D rendering context is a grouping property, and
 * the stage's rule is that nothing in the phone's context may be one (see
 * Stage.tsx for what one cost). So the bezel is `.phone-bezel`: a gradient a
 * pixel larger than the body sits BEHIND an opaque body, and only its edge
 * shows — the same trick the wordmark's mark uses. `--phone-ring` is the
 * gradient's opacity, and it follows `t`, brightening as more of the Pristine
 * side shows; so does the screen light spilling past the edge.
 *
 * WHAT IS OVER THE SCREEN
 * The glass (`.phone-glass`: a highlight sweeping in from the top-left and one
 * thin band, two static gradients kept faint enough that the comparison under
 * them is never the thing they soften), the notch above it, and — with
 * `illustrative` — the one word the landing page's screen carries for the
 * engagement figures floating above it, which moved here from CompareSlider.
 * Nothing here has a filter, a mask or a backdrop filter, and nothing here
 * takes pointer events, so the slider underneath gets every press.
 *
 * THE SLOT
 * `children` is the screen and whatever its owner puts under it (a caption).
 * The body is drawn as a box the size of the screen plus the bezel, its height
 * taken from the width alone by `aspect` — a padding-bottom percentage, the
 * one length in CSS a height can take from a width — so the screen fills it
 * exactly at any width and anything after the screen flows out below the
 * phone rather than into it.
 */

interface Props {
  /** 0 = all crushed, 1 = all Pristine. Drives the ring and the screen light. */
  t: number;
  children: ReactNode;
  /**
   * The screen's proportion, height over width (16/9) or width over height
   * (9/19.5): a phone is taller than it is wide, so either way round is
   * unambiguous.
   */
  aspect?: number;
  className?: string;
  /** Print the `illustrative` legend in the screen's corner. */
  illustrative?: boolean;
}

/* ---- tuning ------------------------------------------------------------ */
/** The bezel: a 1px hairline and 8px of body between the edge and the screen. */
export const BEZEL = 9;
/** The bezel's corner radius, and the screen's inside it. The body's depth
 * (14px) and the slabs' inset from the corners are `.phone-body`'s variables. */
const RADIUS = 46;
const SCREEN_RADIUS = 38;

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** `aspect` as height over width, whichever way round it was given. */
export function screenRatio(aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  return a >= 1 ? a : 1 / a;
}

/**
 * A box the size of the phone — a screen at `ratio` plus the bezel — as a
 * height taken from its own width. Absolutely positioned children measure
 * against it exactly as they would a box with that height.
 */
export function phoneBox(ratio: number): CSSProperties {
  const extra = 2 * BEZEL * (1 - ratio);
  return {
    height: 0,
    paddingBottom: `calc(${(ratio * 100).toFixed(4)}% ${extra < 0 ? '-' : '+'} ${Math.abs(extra).toFixed(3)}px)`,
  };
}

/** The phone's height for a width, px. */
export function phoneHeight(width: number, ratio: number): number {
  return (width - 2 * BEZEL) * ratio + 2 * BEZEL;
}

export default function Phone3D({ t, children, aspect = 16 / 9, className, illustrative = false }: Props) {
  const tt = clamp01(t);
  const r = screenRatio(aspect);

  return (
    <div
      className={['phone3d relative', className].filter(Boolean).join(' ')}
      style={{ transformStyle: 'preserve-3d' }}
    >
      {/* The body. Decorative, and out of the way of the slider's pointer. */}
      <div
        aria-hidden="true"
        className="phone-body pointer-events-none absolute left-0 top-0 w-full"
        style={{ ...phoneBox(r), transformStyle: 'preserve-3d' }}
      >
        {/* The sides and the back, laid out and shaded by their classes. */}
        <div className="phone-face-back" />
        <div className="phone-face-left" />
        <div className="phone-face-right" />
        <div className="phone-face-top" />
        <div className="phone-face-bottom" />

        {/* The bezel: the front of the box, and the only part of it that is
            ever fully in view. Its ring is behind its opaque body; `t` lights it. */}
        <div
          className="phone-bezel absolute inset-0"
          style={{ borderRadius: RADIUS, '--phone-ring': (0.1 + 0.9 * tt).toFixed(3) } as CSSProperties}
        />

        {/* Screen light spilling past the bezel; grows with the Pristine side. */}
        <div
          className="absolute"
          style={{
            inset: -4,
            borderRadius: RADIUS + 4,
            opacity: tt,
            boxShadow: '0 0 70px -8px rgba(124, 92, 255, 0.5), 0 0 140px -24px rgba(78, 240, 255, 0.25)',
            transition: 'opacity 150ms linear',
          }}
        />
      </div>

      {/* The slot: the screen, inset by the bezel, and whatever follows it. A
          hair in front of the bezel so the two never contest the same plane. */}
      <div
        className="relative"
        style={{ padding: `${BEZEL}px`, transform: 'translateZ(0.5px)' }}
      >
        {children}
      </div>

      {/* Over the screen: the glass, the notch, the legend. Clipped to the
          screen's own corners; a hair above it. */}
      <div
        className="pointer-events-none absolute overflow-hidden"
        style={{
          left: BEZEL,
          top: BEZEL,
          width: `calc(100% - ${2 * BEZEL}px)`,
          height: 0,
          paddingBottom: `calc(${(r * 100).toFixed(4)}% - ${(2 * BEZEL * r).toFixed(3)}px)`,
          borderRadius: SCREEN_RADIUS,
          transform: 'translateZ(1px)',
        }}
      >
        {/* The glass: static gradients, under the notch and the legend. */}
        <div aria-hidden="true" className="phone-glass" />

        {/* Notch. Decorative; the picture runs under it as on a real phone. */}
        <div
          aria-hidden="true"
          className="absolute left-1/2 top-2.5 z-20 h-[19px] w-[78px] -translate-x-1/2
                     rounded-full bg-black shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
        />

        {/* The engagement figures floating above are not measured. */}
        {illustrative && (
          <div className="legend absolute bottom-3 left-3 z-20 text-[8.5px] text-white/40">
            illustrative
          </div>
        )}
      </div>
    </div>
  );
}
