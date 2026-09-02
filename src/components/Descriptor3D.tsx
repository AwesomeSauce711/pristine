'use client';

import type { ReactNode } from 'react';

/*
 * The two measured-figure badges, as plates in the air above the screen.
 *
 * Round one printed them flat in the screen's top corners, the way a feed
 * prints its own labels. They carry the real delivered figures — the one part
 * of the comparison that is measured rather than shown — and flat on the
 * glass they were the least noticed thing on the stage. Now each stands
 * seventy pixels off the screen on a plane of light, the way the holograms
 * do, leaning a little toward the reader and a little toward the centre so the
 * pair read as two labels pinned in space over the corners they describe. The
 * words are exactly the ones the badges carried; they arrive as children and
 * this file restates none of them.
 *
 * The plate's material is `.descriptor` (globals.css): an opaque glass body
 * with the mono legend inside and, behind it, a rim that lights with
 * `.descriptor-lit`. `lit` is for the Pristine side: the rim, a glow in the
 * screen's colours, and a beam turned cyan — at the moment the holograms pop
 * and the chime plays. `visible` keeps the badges' old rule (each fades as the
 * divider runs over its corner), applied to the plate and the beam SEPARATELY
 * and never to their common parent: opacity on a parent flattens its
 * children, and the plate would drop onto the glass for the length of every
 * fade. The lift, the leans and the beam are this file's transforms.
 *
 * No filter, mask or backdrop filter — this sits in the stage's overlay
 * context. The beam is hidden from assistive technology; the figures are not.
 */

interface Props {
  side: 'left' | 'right';
  /** Light the plate: the iridescent rim, a glow, a cyan beam. */
  lit?: boolean;
  /** Fade the plate out (the divider is over its corner). */
  visible?: boolean;
  children: ReactNode;
  className?: string;
}

/* ---- tuning ------------------------------------------------------------ */
/** Height above the screen, px. The holograms stand between 85 and 150. */
const LIFT = 70;
/** From the phone's edge to the plate's outer corner, px. */
const INSET = 14;
/** Lean toward the reader — negative brings the top forward — in degrees. */
const LEAN_X = -6;
/** Turn toward the phone's centre, degrees. */
const LEAN_Y = 7;
/** The beam's width, px. */
const BEAM_W = 44;
/** The beam's light, "r,g,b": the holograms' cool white, and cyan when lit. */
const BEAM = '150, 196, 255';
const BEAM_LIT = '78, 240, 255';

const FADE = 'opacity 220ms ease-out';

export default function Descriptor3D({ side, lit = false, visible = true, children, className }: Props) {
  const left = side === 'left';
  const beam = lit ? BEAM_LIT : BEAM;

  return (
    <div
      className={['absolute', className].filter(Boolean).join(' ')}
      style={{
        top: INSET,
        left: left ? INSET : undefined,
        right: left ? undefined : INSET,
        transformStyle: 'preserve-3d',
      }}
    >
      {/* The plane of light between the plate and the screen: hung from the
          plate's bottom edge and turned back ninety degrees, so its far end
          lands on the glass. Its soft sides are in the gradient. */}
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-full"
        style={{
          width: BEAM_W,
          height: LIFT,
          transformOrigin: 'top center',
          transform: `translate3d(-50%, 0, ${LIFT}px) rotateX(-90deg)`,
          background:
            `radial-gradient(60% 100% at 50% 100%, rgba(${beam}, 0.36), `
            + `rgba(${beam}, 0.1) 45%, rgba(${beam}, 0) 100%)`,
          opacity: visible ? 1 : 0,
          transition: `${FADE}, background 400ms ease`,
        }}
      />

      {/* The plate, turned about its outer edge so the pair lean inward. The
          transition restates the material's own (a shorthand replaces it). */}
      <div
        className={lit ? 'descriptor descriptor-lit' : 'descriptor'}
        style={{
          transformOrigin: left ? '0% 50%' : '100% 50%',
          transform: `translateZ(${LIFT}px) rotateX(${LEAN_X}deg) rotateY(${left ? LEAN_Y : -LEAN_Y}deg)`,
          opacity: visible ? 1 : 0,
          transition: `${FADE}, box-shadow 350ms ease, border-color 350ms ease`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
