'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

type Sound = 'click' | 'upload' | 'ready' | 'error';
const KEY = 'pristine-sound';
let fallbackEnabled = true;

function enabled() {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return fallbackEnabled; }
}
function subscribe(update: () => void) {
  window.addEventListener('storage', update);
  window.addEventListener('pristine-sound-change', update);
  return () => {
    window.removeEventListener('storage', update);
    window.removeEventListener('pristine-sound-change', update);
  };
}

export function useSoundEffects() {
  const soundEnabled = useSyncExternalStore(subscribe, enabled, () => true);
  const context = useRef<AudioContext | null>(null);
  const lastClick = useRef(-Infinity);
  const playSound = useCallback((sound: Sound) => {
    if (!enabled()) return;
    try {
      const ctx = context.current ??= new AudioContext();
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      const now = ctx.currentTime;
      if (sound === 'click' && now - lastClick.current < 0.045) return;
      if (sound === 'click') lastClick.current = now;
      const notes = sound === 'click' ? [900] : sound === 'upload' ? [440, 660] : sound === 'ready' ? [660, 880, 1100] : [330, 260];
      notes.forEach((frequency, index) => {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        const start = now + index * 0.075;
        const duration = sound === 'click' ? 0.055 : 0.15;
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, start);
        oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.7, start + duration);
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(sound === 'click' ? 0.045 : 0.065, start + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
        oscillator.connect(gain).connect(ctx.destination);
        oscillator.start(start);
        oscillator.stop(start + duration + 0.01);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      });
    } catch { /* Sound is optional when a browser blocks audio. */ }
  }, []);

  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (!event.isTrusted || event.button !== 0 || (event.target instanceof Element && event.target.closest('[data-sound-toggle], video, input'))) return;
      playSound('click');
    };
    window.addEventListener('click', click, { capture: true });
    return () => {
      window.removeEventListener('click', click, { capture: true });
      void context.current?.close().catch(() => {});
      context.current = null;
    };
  }, [playSound]);

  const toggleSound = () => {
    const next = !enabled();
    fallbackEnabled = next;
    try { localStorage.setItem(KEY, next ? 'on' : 'off'); } catch { /* Keep the in-memory preference. */ }
    window.dispatchEvent(new Event('pristine-sound-change'));
    if (next) playSound('click');
  };
  return { soundEnabled, toggleSound, playSound };
}
