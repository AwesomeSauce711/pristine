'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/*
 * A figure that counts up to itself the first time it is seen.
 *
 * `value` is the finished text, exactly as it must read — "9.0×", "14.4×",
 * "8,294,400 vs 921,600", "0". The first numeric run in it animates; whatever
 * surrounds it (the "×", the " vs 921,600") is emitted untouched. Two frames
 * are never computed: the server render and the resting frame are `value`
 * itself, verbatim. Every number on the page is a measurement, and a number
 * that has to be reproduced by formatting code is a number that can drift from
 * what was measured. So the in-between frames are made up, briefly, and the
 * text at rest is the string that was passed in.
 *
 * In-between frames are formatted the way the finished text is — the same
 * decimal places, thousands separators only if it has them — and are always
 * rounded DOWN, so no frame reaches the target early and the figure is seen
 * to arrive rather than to have been sitting there for the last half second.
 *
 * Nothing is hidden until an IntersectionObserver is confirmed to exist, the
 * same rule `Reveal` follows: a crawler, a reader without JavaScript, or a
 * browser without the API gets the finished figure and no count. So does
 * anyone who has asked for reduced motion.
 */

interface Props {
  /** The finished text, exactly as it must read. */
  value: string;
  /** Length of the count, in ms. */
  duration?: number;
  className?: string;
  /** Pause between entering the viewport and starting to count, in ms. */
  delay?: number;
  /** Called once, the moment a count lands on its final frame. Not called
   *  when there is no count — reduced motion, no observer, a zero. */
  onDone?: () => void;
}

interface Run {
  /** Text before the number, untouched. */
  prefix: string;
  /** The number as written, e.g. "8,294,400". */
  text: string;
  /** Text after the number, untouched. */
  suffix: string;
  target: number;
  decimals: number;
  grouped: boolean;
}

/*
 * The first run of digits: either thousands-grouped with commas ("8,294,400")
 * or plain ("14.4"), with at most one decimal point. A grouped form is tried
 * first so "1,234" is one number and not "1" followed by ",234".
 */
const RUN = /\d+(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/;

function parseRun(value: string): Run | null {
  const m = RUN.exec(value);
  if (!m) return null;
  const text = m[0];
  const target = Number(text.replace(/,/g, ''));
  // A zero has nothing to count up to; treat it like text.
  if (!Number.isFinite(target) || target <= 0) return null;
  const dot = text.indexOf('.');
  return {
    prefix: value.slice(0, m.index),
    text,
    suffix: value.slice(m.index + text.length),
    target,
    decimals: dot === -1 ? 0 : text.length - dot - 1,
    grouped: text.includes(','),
  };
}

/* Format `n` the way the finished run is written, rounding down. */
function formatLike(n: number, run: Run): string {
  const scale = 10 ** run.decimals;
  const fixed = (Math.floor(n * scale) / scale).toFixed(run.decimals);
  if (!run.grouped) return fixed;
  const dot = fixed.indexOf('.');
  const whole = dot === -1 ? fixed : fixed.slice(0, dot);
  const rest = dot === -1 ? '' : fixed.slice(dot);
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + rest;
}

/* Ease-out quartic: most of the distance in the first third, a long settle
 * where only the small digits are still moving. */
function easeOut(t: number): number {
  return 1 - (1 - t) ** 4;
}

export default function CountUp({ value, duration = 1400, className, delay = 0, onDone }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const run = useMemo(() => parseRun(value), [value]);
  // The run's text mid-count; null means at rest, showing `value`.
  const [shown, setShown] = useState<string | null>(null);
  // Read through a ref so a new callback identity on a parent's re-render
  // cannot restart the count (the effect below would otherwise re-run and
  // hide the figure again).
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !run || duration <= 0) return;
    if (typeof IntersectionObserver === 'undefined' || typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    /*
     * Only now is it safe to hide the figure: we know we can show it again.
     *
     * Hidden by hand rather than through state, and brought back by the same
     * commit that puts the first counted frame in (the inline style below).
     * Done as two separate steps, the finished figure would paint for a frame
     * at 40% visible and then snap to zero, which reads as a glitch rather
     * than as a count.
     */
    el.style.opacity = '0';

    let timer = 0;
    let raf = 0;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        timer = window.setTimeout(() => {
          const t0 = performance.now();
          // A hidden tab gets no animation frames, so the count simply pauses
          // and lands on its final frame when the tab comes back.
          const frame = (now: number) => {
            const t = Math.min(1, (now - t0) / duration);
            if (t >= 1) {
              setShown(null);
              onDoneRef.current?.();
              return;
            }
            setShown(formatLike(run.target * easeOut(t), run));
            raf = requestAnimationFrame(frame);
          };
          raf = requestAnimationFrame(frame);
        }, Math.max(0, delay));
      },
      { threshold: 0.4 },
    );
    io.observe(el);

    return () => {
      io.disconnect();
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
      el.style.opacity = '';
    };
  }, [run, duration, delay]);

  return (
    <span ref={ref} className={className} style={shown !== null ? { opacity: 1 } : undefined}>
      {shown !== null && run ? (
        <>
          {run.prefix}
          {/*
            * The finished run holds the width, invisibly, and the counted run
            * sits over it aligned to the right, so a suffix like "×" or
            * " vs 921,600" does not creep sideways as the digits fill in.
            * `visibility: hidden` keeps the holder out of innerText and out of
            * the accessibility tree; it exists only while counting.
            *
            * The two share one grid cell rather than one being positioned
            * absolutely: a positioned descendant falls outside a parent's
            * `background-clip: text`, and the numbers on the landing page are
            * set in the iridescent gradient — absolutely positioned, the
            * digits counted up invisibly and only the suffix showed.
            */}
          <span className="inline-grid whitespace-nowrap [&>*]:[grid-area:1/1]">
            <span aria-hidden="true" className="invisible">{run.text}</span>
            <span className="justify-self-end">{shown}</span>
          </span>
          {run.suffix}
        </>
      ) : (
        value
      )}
    </span>
  );
}
