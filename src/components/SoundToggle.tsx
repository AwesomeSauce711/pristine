'use client';

import { arm, play } from '@/lib/sound';
import { useSoundEnabled } from '@/lib/useSound';

/*
 * The one control for the sounds.
 *
 * A 40 px round glass button with a speaker in it, for the floating dock.
 * Icon only, so it carries no copy: the label lives in `aria-label` ("Sound
 * on" / "Sound off", the two new strings the contract allows) and the state
 * in `aria-pressed`, which is also what the stylesheet reads to draw it lit
 * or muted. Turning it on plays `tick` — the setting confirming itself in
 * the medium it controls — and turning it off plays nothing, because it is
 * now off.
 *
 * WHY IT ARMS THE CONTEXT ITSELF
 * A click is a user gesture. The module already arms on the first one from
 * a capture-phase listener, so by the time this handler runs the context
 * exists; calling `arm()` again is free and covers the day that listener is
 * gone (it removes itself once the context runs, and comes back only if the
 * context leaves that state). The tick then has something to play on.
 *
 * The two icon states are two groups with a short opacity transition — the
 * waves fade out as the cross fades in — so the switch reads as one glyph
 * changing rather than one glyph replaced. Nothing here is an effect; the
 * hook is a store read and the click is the only write.
 */

/*
 * The hover helper, available from here as well as from src/lib/sound.ts so
 * a control next to the toggle can take both from one import. From a CLIENT
 * component only: this file is a client module, so a server component that
 * imports the helper from here receives a reference it cannot call.
 */
export { soundProps } from '@/lib/sound';

interface Props {
  className?: string;
}

const cx = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(' ');

const FADE = { transition: 'opacity 240ms ease' } as const;

export default function SoundToggle({ className }: Props) {
  const [on, setOn] = useSoundEnabled();

  const toggle = () => {
    const next = !on;
    arm();
    setOn(next);
    if (next) play('tick');
  };

  return (
    <button
      type="button"
      className={cx('sound-toggle', 'inline-grid h-11 w-11 place-items-center rounded-full pointer-fine:h-10 pointer-fine:w-10', className)}
      aria-label={on ? 'Sound on' : 'Sound off'}
      aria-pressed={on}
      onClick={toggle}
    >
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/* The speaker. */}
        <path d="M4 9.5v5h3.1L12 18.6V5.4L7.1 9.5H4z" />
        {/* Its sound, when on. */}
        <g style={{ ...FADE, opacity: on ? 1 : 0 }}>
          <path d="M15.4 9.3a3.8 3.8 0 0 1 0 5.4" />
          <path d="M18.1 6.7a7.5 7.5 0 0 1 0 10.6" />
        </g>
        {/* The cross, when off. */}
        <g style={{ ...FADE, opacity: on ? 0 : 1 }}>
          <path d="M15.5 9.8l4.6 4.6M20.1 9.8l-4.6 4.6" />
        </g>
      </svg>
    </button>
  );
}
