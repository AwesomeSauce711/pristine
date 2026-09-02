import { sceneIsLite } from '@/lib/scene-tier';
/*
 * stage-motion.ts — where the reader is "looking", as one pair of numbers.
 *
 * Everything that turns with the reader — the phone, the hand behind it, the
 * holograms, the comparison split, the hero field, the starfield — reads from
 * here, so they can never disagree about the angle. `x` and `y` run from −1
 * to 1 and 0 is the centre.
 *
 * ON A DESKTOP the pointer drives it, measured against the whole viewport: the
 * edge of the page is ±1 however wide the page is, and nothing resets when the
 * pointer leaves some element — the only way back to centre is to move back to
 * the centre.
 *
 * ON A PHONE the gyroscope drives it: rolling the phone side to side is `x`,
 * and pitching it is `y` relative to however it was being held when the first
 * reading arrived — so the whole site leans with the phone, the way the
 * pointer leans it on a desktop. iOS only hands out orientation events after a
 * permission prompt, and that prompt may only be raised from a user gesture
 * and only on a secure (HTTPS) page, which is why `requestGyro()` exists and
 * why the stage offers a "tilt" button that asks (a dialog nobody asked for
 * sends people away). Android needs no prompt and starts on the first
 * subscription. Where there is no sensor, or permission is refused, the
 * site simply rests and the comparison is moved by dragging its handle.
 *
 * Consumers ease toward these values themselves; this module only reports.
 */

export interface Motion {
  /** −1 (left edge, or rolled left) to 1 (right edge, or rolled right). */
  x: number;
  /** −1 (top edge, or pitched away) to 1 (bottom edge, or pitched toward). */
  y: number;
  source: 'pointer' | 'gyro' | 'none';
}

/* The phone's tilt, in degrees: the rest lean, and how far it turns. Shared by
 * the DOM phone and the WebGL hand so the two always agree. */
export const TILT_REST_X = 8;
export const TILT_RANGE_X = 4;
export const TILT_RANGE_Y = 9;

/** The phone's rotation for a reading. `rx` about the horizontal axis, `ry` about the vertical. */
export function tiltFor(m: Motion): { rx: number; ry: number } {
  return { rx: TILT_REST_X + m.y * TILT_RANGE_X, ry: -m.x * TILT_RANGE_Y };
}

/**
 * The comparison split for a horizontal reading, as the slider's `pos`
 * (percent from the left where the Pristine side begins): rolled fully left
 * is all crushed (100), rolled fully right is all Pristine (0). A pointer is
 * not mapped here — the sliders put the divider where the pointer is,
 * measured across the screen itself (CompareSlider, PreviewCompare).
 */
export function splitFor(x: number): number {
  return Math.min(100, Math.max(0, 50 - x * 50));
}

/* Degrees of roll or pitch that count as the full travel: a small tilt is
 * the whole comparison, so nobody has to crane the phone to see it. */
const GYRO_FULL_DEG = 11;

const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(-1, v)) : 0);

const state: Motion = { x: 0, y: 0, source: 'none' };
const listeners = new Set<(m: Motion) => void>();
let pointerInstalled = false;
let gyroInstalled = false;
let gyroBaseBeta: number | null = null;

function emit() {
  for (const fn of listeners) fn(state);
}

function onPointer(e: PointerEvent) {
  /* A finger is scrolling, not pointing. */
  if (e.pointerType === 'touch') return;
  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  state.x = clamp((e.clientX / w) * 2 - 1);
  state.y = clamp((e.clientY / h) * 2 - 1);
  state.source = 'pointer';
  emit();
}

function isLandscape(): boolean {
  const t = window.screen?.orientation?.type;
  if (t) return t.startsWith('landscape');
  return window.innerWidth > window.innerHeight;
}

/*
 * Orientation events arrive at up to 60 Hz and every listener re-renders
 * on each, so they are coalesced: the latest reading is kept and one emit
 * goes out per animation frame. The roll is reversed from the raw sensor —
 * tilting the right edge down reveals the right-hand (Pristine) side, the
 * way a hand leaning that way would drag the divider.
 */
let gyroRaf = 0;
let gyroLatest: DeviceOrientationEvent | null = null;
function flushOrientation() {
  gyroRaf = 0;
  const e = gyroLatest;
  gyroLatest = null;
  if (!e || e.gamma == null || e.beta == null) return;
  if (gyroBaseBeta === null) gyroBaseBeta = e.beta;
  /* Portrait: gamma is roll (side to side), beta is pitch. Landscape swaps
   * them, and roll now reads from beta about its resting value. */
  let x: number;
  let y: number;
  if (isLandscape()) {
    x = -(e.beta - gyroBaseBeta) / GYRO_FULL_DEG;
    y = -e.gamma / GYRO_FULL_DEG;
  } else {
    x = -e.gamma / GYRO_FULL_DEG;
    y = (e.beta - gyroBaseBeta) / GYRO_FULL_DEG;
  }
  state.x = clamp(x);
  state.y = clamp(y);
  state.source = 'gyro';
  emit();
}
function onOrientation(e: DeviceOrientationEvent) {
  gyroLatest = e;
  if (!gyroRaf) gyroRaf = requestAnimationFrame(flushOrientation);
}

function installPointer() {
  if (pointerInstalled || typeof window === 'undefined') return;
  pointerInstalled = true;
  window.addEventListener('pointermove', onPointer, { passive: true });
}

function installGyro() {
  if (gyroInstalled || typeof window === 'undefined') return;
  gyroInstalled = true;
  gyroBaseBeta = null;
  window.addEventListener('deviceorientation', onOrientation, { passive: true });
}

function uninstall() {
  if (typeof window === 'undefined') return;
  if (pointerInstalled) window.removeEventListener('pointermove', onPointer);
  if (gyroInstalled) window.removeEventListener('deviceorientation', onOrientation);
  if (gyroRaf) cancelAnimationFrame(gyroRaf);
  gyroRaf = 0;
  pointerInstalled = false;
  gyroInstalled = false;
}

/** Whether the gyroscope is feeding the store. */
export function gyroActive(): boolean {
  return gyroInstalled;
}

/** Whether this device will need `requestGyro()` before orientation events flow (iOS). */
export function gyroNeedsPermission(): boolean {
  if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return false;
  const D = window.DeviceOrientationEvent as unknown as { requestPermission?: unknown };
  return typeof D.requestPermission === 'function';
}

/**
 * Ask for orientation events. Must be called from a user gesture on iOS, on
 * a secure page. Resolves true once events are flowing (or will be, on
 * platforms that need no prompt). Safe to call repeatedly.
 */
export async function requestGyro(): Promise<boolean> {
  if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return false;
  const D = window.DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<'granted' | 'denied'>;
  };
  try {
    if (typeof D.requestPermission === 'function') {
      const r = await D.requestPermission();
      if (r !== 'granted') return false;
    }
  } catch {
    return false;
  }
  installGyro();
  return true;
}

/** Re-centre the gyroscope on however the phone is held right now. */
export function recentreGyro(): void {
  gyroBaseBeta = null;
}

/** The last reading. */
export function getMotion(): Motion {
  return state;
}

/**
 * Subscribe to readings. The first subscriber installs the listeners; the
 * last one leaving removes them. On a touch device with no permission prompt
 * (Android) the gyroscope starts here; on iOS it starts at `requestGyro()`,
 * from the stage's tilt button.
 */
export function subscribeMotion(fn: (m: Motion) => void): () => void {
  listeners.add(fn);
  if (listeners.size === 1 && typeof window !== 'undefined') {
    installPointer();
    const coarse =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    /* Android needs no prompt and starts here. iOS asks permission with a
     * system dialog, which is never raised behind someone's back: the stage
     * shows a "tilt" button and the tap on that asks (requestGyro). */
    /* Not on a lite device (which every phone is): a phone is never quite
     * still, so the gyroscope kept every follow-the-reader loop -- the stage,
     * the plates, the galaxy, the field -- awake and painting for as long as
     * the page was open. The stage's own tilt button still asks for it. */
    if (coarse && !sceneIsLite() && !gyroNeedsPermission()) installGyro();
  }
  fn(state);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) uninstall();
  };
}
