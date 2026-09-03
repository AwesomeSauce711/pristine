import { useSyncExternalStore } from 'react';
import { isEnabled, setEnabled, subscribe } from '@/lib/sound';

/*
 * useSound.ts — the sound setting as React state.
 *
 * The setting lives in src/lib/sound.ts (one value, kept in localStorage and
 * synced across tabs); this hook just reads it through useSyncExternalStore,
 * so every toggle on the page shows the same state and a change in another
 * tab re-renders this one. No effect, no local copy of the value.
 *
 * WHY THE SERVER SNAPSHOT IS "ON"
 * The server cannot see the reader's localStorage, so it renders the
 * default, which is on. If the reader had muted, React re-renders the toggle
 * with the stored value right after hydrating, with no mismatch error — that
 * is what the third argument is for. The toggle lives in a dock that appears
 * only after the first viewport has been scrolled past, so the correction is
 * never seen.
 *
 * No 'use client' here on purpose: the directive would turn `soundProps`
 * into a client reference for anyone importing it from a server component,
 * and a hook needs no directive — the component that calls it carries one.
 */

export { play, soundProps, arm } from '@/lib/sound';
export type { SoundName, PlayOptions } from '@/lib/sound';

const serverSnapshot = () => true;

/** `[enabled, setEnabled]` — the sound setting, live. */
export function useSoundEnabled(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, isEnabled, serverSnapshot);
  return [on, setEnabled];
}
