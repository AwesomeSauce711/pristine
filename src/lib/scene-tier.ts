/*
 * scene-tier.ts — is this a device that can afford the full scene?
 *
 * WHY THIS EXISTS
 * Every decorative loop on the site — the galaxy, the ribbons, the globe, the
 * plate tilt, the nav parallax, the engagement rain — already knows how to
 * stand still: each has a branch for `prefers-reduced-motion`. What none of
 * them had was any idea they were on a phone. A phone that has not asked for
 * reduced motion got everything at once: two WebGL contexts, a thousand
 * projected stars, a gyroscope keeping every follow-the-reader loop awake,
 * animated blurs and backdrop filters over a moving canvas, and a 4K60 video
 * decode underneath it all. It ran hot, dropped frames, and the video — the one
 * thing the page is for — stalled. That was reported from a real phone, which
 * is the only instrument that could have measured it.
 *
 * So there is one answer to "should this move?", and phones say no.
 *
 * WHAT COUNTS AS LITE
 *   - the reader asked for reduced motion (always honoured, as before)
 *   - a coarse pointer: phones and tablets, whatever their spec. A fast phone
 *     still has a phone's thermal budget and a phone's battery
 *   - Save-Data, or few cores, or little memory: a laptop that would struggle
 *
 * HOW IT PLUGS IN
 * `stillQuery()` returns a real MediaQueryList, so the components keep their
 * `.matches` reads and their `change` listeners exactly as they were — the
 * swap from the old reduced-motion matchMedia call is one token. The static
 * factors (cores, memory, Save-Data) cannot be expressed as media, so when one
 * of them applies the query is simply `all`, which always matches.
 *
 * The CSS half of the same decision is `(pointer: coarse)` alongside
 * `(prefers-reduced-motion: reduce)` in globals.css; keep the two in step.
 */

import { useSyncExternalStore } from 'react';

const MOTION_QUERY = '(prefers-reduced-motion: reduce), (pointer: coarse)';

const canMatch = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

/** Factors that do not change during a visit. */
function staticallyLite(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean };
    deviceMemory?: number;
  };
  if (nav.connection?.saveData) return true;
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 4) return true;
  if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency <= 4) return true;
  return false;
}

let cached: MediaQueryList | null = null;

/**
 * The "hold still" query. `.matches` is true when the scene should not move;
 * listen to `change` for the reader toggling reduced motion or a tablet
 * gaining a mouse.
 */
export function stillQuery(): MediaQueryList {
  if (cached) return cached;
  cached = window.matchMedia(staticallyLite() ? 'all' : MOTION_QUERY);
  return cached;
}

/** Same answer, for code that runs where matchMedia may not exist. */
export function sceneIsLite(): boolean {
  return canMatch() ? stillQuery().matches : false;
}

function subscribe(onChange: () => void) {
  if (!canMatch()) return () => {};
  const mq = stillQuery();
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
const getSnapshot = () => sceneIsLite();
/* The server does not know the device; it renders the full page and the
 * client settles the question on hydration. */
const getServerSnapshot = () => false;

/** The lite decision as render state, without a hydration mismatch. */
export function useSceneLite(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
