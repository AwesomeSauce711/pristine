/*
 * sound.ts — the site's sounds, synthesised.
 *
 * Eight small sounds, made on a Web Audio graph from oscillators and a burst
 * of filtered noise each, so there is nothing to download, nothing to decode
 * and nothing external for the CSP to refuse. They exist for one reason: the
 * page is meant to make the reader want the product, and a soft, bright
 * response to a hover, a reveal, a count landing, a file dropped, is the
 * cheapest dopamine there is. They are designed quiet — heard when listened
 * for, never noticed otherwise — and `reveal`, the ascending chime, is the
 * signature: it plays whenever the Pristine side is shown or the name pops,
 * so the sound and the name become the same thing.
 *
 * WHY NOTHING PLAYS UNTIL A GESTURE
 * Browsers refuse to start audio until the reader has touched the page, and
 * a context created before then is born suspended (and logs a warning). So
 * the AudioContext is created only inside a gesture: this module installs
 * capture-phase listeners on `window` for the first pointer, touch and key
 * events, each of which calls `arm()`. They remove themselves the moment the
 * context reports `running` and come back if it ever leaves that state (iOS
 * suspends it for a phone call). Chrome grants activation on `pointerdown`
 * for a mouse but only on `pointerup`/`touchend` for a finger, which is why
 * both ends of each gesture are listened for: a single `touchstart` listener
 * that removed itself would have asked one event too early and never asked
 * again.
 *
 * WHY play() CAN NEVER FAIL
 * It is called from hover handlers, effects and slider callbacks all over the
 * page, on the server render as well as in the browser, and nothing that
 * calls it should have to think about audio. So it is a silent no-op before
 * the context exists, when muted, when the tab is hidden, when the same
 * sound was played less than 45 ms ago, and when eight voices are already
 * sounding — a counter that lands forty times in one frame makes one tick,
 * not a buzz — and the synthesis itself is wrapped so a node the browser
 * lacks becomes silence, not an exception.
 *
 * LEVELS
 * Every design peaks near unity before the master, which sits at 0.22
 * (about −13 dB). A gentle compressor in front of it catches two sounds
 * landing together. Muting ramps the master to zero over a few milliseconds
 * rather than stopping voices, so a chime in flight fades instead of
 * clicking off; unmuting is instant so the tick that confirms it is heard.
 *
 * The choice is kept in `localStorage['pristine.sound']` (`on` / `off`,
 * default on) and the `storage` event carries a change made in another tab
 * into this one, so muting in one tab mutes them all.
 */

export type SoundName = 'hover' | 'tick' | 'pop' | 'reveal' | 'brand' | 'success' | 'drop' | 'whoosh';

export const SOUND_NAMES: readonly SoundName[] = [
  'hover', 'tick', 'pop', 'reveal', 'brand', 'success', 'drop', 'whoosh',
];

export interface PlayOptions {
  /** Multiplies the sound's level; 1 is as designed. Clamped to 0–2. */
  gain?: number;
  /**
   * Playback rate, as a sampler would take it: 2 is an octave up and half as
   * long, 0.5 an octave down and twice as long. Clamped to 0.25–4. A counter
   * can climb in pitch as it climbs in value.
   */
  rate?: number;
}

/* ---- Tuning ------------------------------------------------------------ */

/** The one volume control. Everything below is designed to peak near 1 before it. */
/*
 * Lowered from 0.22. The site is not a game; the sounds are confirmations.
 * The three that matter -- a file landing, the preview arriving, the download
 * saved -- keep their voicing; the rest are quieter or gone.
 */
const MASTER_GAIN = 0.15;
/** Repeats of the same sound closer together than this are dropped. */
const MIN_GAP_MS = 45;
/** Sounds allowed to overlap; a seventh is dropped, never queued. */
const MAX_VOICES = 6;
/** The reverb's length and its level in the mix: a small bright room, not a hall.
 * Short and quiet on purpose — a long tail is what made the sounds smear. */
const REVERB_SECONDS = 0.4;
const REVERB_LEVEL = 0.18;
/** Time constant of the master's fall to silence on mute, seconds. */
const MUTE_RAMP_S = 0.012;
/** Scheduling lookahead, seconds: enough that an attack is never partly in the past. */
const LOOKAHEAD_S = 0.005;
const STORAGE_KEY = 'pristine.sound';

const clamp = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;

/* ---- On / off ---------------------------------------------------------- */

/* Read lazily: the module is evaluated on the server too, where there is no storage. */
let enabled: boolean | null = null;
const listeners = new Set<(on: boolean) => void>();

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Whether sounds are on. Always true on the server, where nothing plays anyway. */
export function isEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  if (enabled === null) enabled = readStored();
  return enabled;
}

function emit() {
  const on = isEnabled();
  for (const fn of listeners) fn(on);
}

/** Turn sounds on or off, remember it, and tell every subscriber (and every other tab). */
export function setEnabled(on: boolean): void {
  if (typeof window === 'undefined' || isEnabled() === on) return;
  enabled = on;
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    /* Private mode or a full quota: the choice lasts this page, which is still honoured. */
  }
  applyMaster();
  emit();
}

/**
 * Subscribe to the on/off state. Shaped for `useSyncExternalStore` (the
 * callback may ignore its argument) and for anything else that wants to know.
 */
export function subscribe(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/* Another tab changed the setting; `key` is null when storage was cleared. */
function onStorage(e: StorageEvent) {
  if (e.key !== null && e.key !== STORAGE_KEY) return;
  const on = readStored();
  if (on === enabled) return;
  enabled = on;
  applyMaster();
  emit();
}

/* ---- The context and its graph ----------------------------------------- */

type ContextCtor = typeof AudioContext;

let ctx: AudioContext | null = null;
/** Where every voice lands: bus → compressor → master → speakers. */
let bus: GainNode | null = null;
let master: GainNode | null = null;
/** The reverb's input; voices that want a room send a little of themselves here. */
let reverb: ConvolverNode | null = null;
/** A second and a half of white noise, made once; every hiss is a grain of it. */
let noise: AudioBuffer | null = null;

function contextCtor(): ContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: ContextCtor; webkitAudioContext?: ContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/*
 * A room, from noise: white noise under a steep decay, a different draw per
 * ear so the tail has width, and a one-pole low-pass over it so the
 * reflections darken the way real ones do — a bare noise tail hisses. The
 * convolver normalises it, so its level is set by REVERB_LEVEL alone.
 */
function impulse(c: AudioContext): AudioBuffer {
  const n = Math.max(1, Math.round(c.sampleRate * REVERB_SECONDS));
  const buf = c.createBuffer(2, n, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp += (Math.random() * 2 - 1 - lp) * 0.4;
      d[i] = lp * Math.pow(1 - i / n, 2.8);
    }
  }
  return buf;
}

function whiteNoise(c: AudioContext): AudioBuffer {
  const n = Math.max(1, Math.round(c.sampleRate * 1.5));
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/*
 * bus → master → speakers. There is no compressor: a DynamicsCompressorNode
 * carries a fixed look-ahead of several milliseconds, which was the audible
 * lag between a click and its sound. The master sits low enough that the
 * few voices allowed to overlap cannot clip without it.
 */
function buildGraph(c: AudioContext) {
  const m = c.createGain();
  m.gain.value = isEnabled() ? MASTER_GAIN : 0;
  const b = c.createGain();
  b.connect(m);
  m.connect(c.destination);

  const r = c.createConvolver();
  r.buffer = impulse(c);
  const ret = c.createGain();
  ret.gain.value = REVERB_LEVEL;
  r.connect(ret);
  ret.connect(b);

  bus = b;
  master = m;
  reverb = r;
  noise = whiteNoise(c);
}

function applyMaster() {
  if (!ctx || !master) return;
  const t = ctx.currentTime;
  master.gain.cancelScheduledValues(t);
  if (isEnabled()) {
    /* Instant, so the tick that confirms the switch is not under the ramp. */
    master.gain.setValueAtTime(MASTER_GAIN, t);
  } else {
    master.gain.setTargetAtTime(0, t, MUTE_RAMP_S);
  }
}

function onStateChange() {
  if (!ctx) return;
  if (ctx.state === 'running') {
    removeGestures();
    /* The sound that was asked for while the context was still waking —
     * the first click's, usually — plays now rather than being lost. */
    const p = pending;
    pending = null;
    if (p && performance.now() - p.at < PENDING_MS) play(p.name, p.opts);
  } else if (ctx.state !== 'closed') installGestures();
}

/* A sound asked for before the context was running, kept briefly. */
let pending: { name: SoundName; opts?: PlayOptions; at: number } | null = null;
const PENDING_MS = 400;

/**
 * Create the AudioContext if there is none and resume it if it is not
 * running. Only useful from inside a user gesture (the module calls it from
 * the first one itself); harmless anywhere, any number of times, and a no-op
 * on the server and in a browser without Web Audio.
 */
export function arm(): void {
  if (typeof window === 'undefined') return;
  if (!ctx) {
    const Ctor = contextCtor();
    if (!Ctor) {
      /* No Web Audio here: nothing will ever play, so stop listening for a gesture. */
      removeGestures();
      return;
    }
    let c: AudioContext;
    try {
      c = new Ctor({ latencyHint: 'interactive' });
    } catch {
      /* Usually transient (too many contexts open in this tab): the next gesture tries again. */
      return;
    }
    try {
      buildGraph(c);
    } catch {
      /* A graph this browser cannot build never will; close the context
       * rather than leak one per gesture, and stop listening. */
      void c.close().catch(() => {});
      removeGestures();
      return;
    }
    c.onstatechange = onStateChange;
    ctx = c;
  }
  if (ctx.state === 'running') {
    removeGestures();
    return;
  }
  if (typeof ctx.resume === 'function') {
    ctx.resume().then(onStateChange).catch(() => {
      /* Still suspended; the next gesture asks again. */
    });
  }
}

/* ---- The first gesture ------------------------------------------------- */

const GESTURES = ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'click'] as const;
let gesturesOn = false;

function onGesture() {
  arm();
}

function installGestures() {
  if (gesturesOn || typeof window === 'undefined') return;
  gesturesOn = true;
  for (const ev of GESTURES) window.addEventListener(ev, onGesture, { capture: true, passive: true });
}

function removeGestures() {
  if (!gesturesOn) return;
  gesturesOn = false;
  for (const ev of GESTURES) window.removeEventListener(ev, onGesture, { capture: true });
}

/* ---- Voices ------------------------------------------------------------ */

/*
 * One call to play() is one voice: a few sources scheduled against a shared
 * start time, each with its own envelope, all landing on the bus. `rate`
 * scales every frequency up and every time down, as a sampler's playback
 * rate would; `level` scales every peak.
 */
interface Voice {
  c: AudioContext;
  out: AudioNode;
  wet: AudioNode | null;
  noise: AudioBuffer;
  t0: number;
  level: number;
  rate: number;
}

interface Env {
  /** Start, seconds after the voice's start. */
  at?: number;
  /** Peak level, 0–1 before the master. */
  level: number;
  /** Rise to the peak, seconds. */
  attack?: number;
  /** Time constant of the fall, seconds; the sound is gone after about six of them. */
  decay: number;
  /** How much of it goes to the reverb, 0–1. */
  wet?: number;
  /** −1 left … 1 right. Ignored where the browser has no panner. */
  pan?: number;
}

interface Tone extends Env {
  type: OscillatorType;
  /** Hz. */
  freq: number;
  /** Glide to this frequency over `glide` seconds. */
  to?: number;
  glide?: number;
  /** Cents off the frequency, for a second oscillator that widens the first. */
  detune?: number;
}

interface Hiss extends Env {
  filter: BiquadFilterType;
  /** The filter's frequency, Hz. */
  freq: number;
  /** Sweep the filter to this frequency over `glide` seconds. */
  to?: number;
  glide?: number;
  q?: number;
}

/*
 * The envelope and the wiring out: source → (filter) → envelope → (panner)
 * → bus, with an optional send to the reverb. Everything is disconnected
 * when the source ends, so a voice leaves nothing behind. Returns the time
 * the source stops.
 */
function wire(v: Voice, src: AudioScheduledSourceNode, tail: AudioNode, e: Env, offset = 0): number {
  const { c } = v;
  const at = v.t0 + (e.at ?? 0) / v.rate;
  const attack = (e.attack ?? 0.002) / v.rate;
  const decay = e.decay / v.rate;
  const peak = Math.max(0, e.level * v.level);
  const end = at + attack + decay * 6;

  const env = c.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(peak, at + attack);
  env.gain.setTargetAtTime(0, at + attack, decay);
  tail.connect(env);

  let last: AudioNode = env;
  let pan: StereoPannerNode | null = null;
  if (e.pan !== undefined && typeof c.createStereoPanner === 'function') {
    pan = c.createStereoPanner();
    pan.pan.value = clamp(e.pan, -1, 1);
    env.connect(pan);
    last = pan;
  }
  last.connect(v.out);

  let send: GainNode | null = null;
  if (e.wet && v.wet) {
    send = c.createGain();
    send.gain.value = clamp(e.wet, 0, 1);
    last.connect(send);
    send.connect(v.wet);
  }

  src.onended = () => {
    src.disconnect();
    tail.disconnect();
    env.disconnect();
    pan?.disconnect();
    send?.disconnect();
  };
  if (offset > 0 && 'buffer' in src) (src as AudioBufferSourceNode).start(at, offset);
  else src.start(at);
  src.stop(end);
  return end;
}

function tone(v: Voice, t: Tone): number {
  const o = v.c.createOscillator();
  o.type = t.type;
  const at = v.t0 + (t.at ?? 0) / v.rate;
  o.frequency.setValueAtTime(t.freq * v.rate, at);
  if (t.to !== undefined) {
    o.frequency.exponentialRampToValueAtTime(t.to * v.rate, at + (t.glide ?? 0.05) / v.rate);
  }
  if (t.detune) o.detune.value = t.detune;
  return wire(v, o, o, t);
}

function hiss(v: Voice, h: Hiss): number {
  const s = v.c.createBufferSource();
  s.buffer = v.noise;
  s.loop = true;
  const f = v.c.createBiquadFilter();
  f.type = h.filter;
  f.Q.value = h.q ?? 1;
  const at = v.t0 + (h.at ?? 0) / v.rate;
  f.frequency.setValueAtTime(h.freq * v.rate, at);
  if (h.to !== undefined) {
    f.frequency.exponentialRampToValueAtTime(h.to * v.rate, at + (h.glide ?? 0.05) / v.rate);
  }
  s.connect(f);
  /* Start somewhere in the buffer, so two bursts in a row are not the same grain. */
  return wire(v, s, f, h, Math.random() * 1.2);
}

/* ---- The eight sounds -------------------------------------------------- */

/* Pitches, Hz. Everything tonal lives in E major, so any two that overlap agree. */
const E5 = 659.255;
const GS5 = 830.609;
const B5 = 987.767;
const E6 = 1318.51;
const E7 = 2637.02;
const GS7 = 3322.44;
const B7 = 3951.07;

/* Each design schedules its sources and returns the time the last one stops. */
const DESIGNS: Record<SoundName, (v: Voice) => number> = {
  /* A fingertip touching glass: one soft sine tap, a little under 1.5 kHz,
   * falling as it goes, about fifteen milliseconds. No noise grain — the
   * grain read as static. */
  /* Silent. A chirp on every button hover was the "unnecessary" one: it
   * fired dozens of times a minute for nothing that had happened. The name
   * stays so no caller changes; it simply plays nothing. */
  hover: () => 0,

  /* A rounder, slightly higher tap for a counter landing on its figure or a
   * step of the slider. */
  tick: (v) =>
    tone(v, { type: 'sine', freq: 2200, to: 1700, glide: 0.01, level: 0.09, attack: 0.0008, decay: 0.004 }),

  /* A bubble: a sine rising 380 → 640 Hz as it bursts, gone in ninety milliseconds. */
  pop: (v) =>
    Math.max(
      tone(v, { type: 'sine', freq: 380, to: 640, glide: 0.09, level: 0.38, attack: 0.003, decay: 0.028 }),
      hiss(v, { filter: 'highpass', freq: 1800, level: 0.06, attack: 0.0005, decay: 0.0015 }),
    ),

  /*
   * The signature: E5 → B5 → E6, a bright triangle with a detuned twin for
   * width and a whisper of the octave for shine, each note a little further
   * to the right than the last so the chime climbs across the room as well
   * as up it, with half of it sent to the reverb. About 280 ms of notes and
   * a short tail.
   */
  reveal: (v) => {
    let end = 0;
    [E5, B5, E6].forEach((f, i) => {
      const at = i * 0.075;
      const pan = (i - 1) * 0.28;
      end = Math.max(
        end,
        tone(v, { type: 'triangle', freq: f, at, level: 0.3, attack: 0.003, decay: 0.075, pan, wet: 0.5 }),
        tone(v, { type: 'triangle', freq: f, detune: 6, at, level: 0.16, attack: 0.004, decay: 0.07, pan: -pan * 0.5, wet: 0.5 }),
        tone(v, { type: 'sine', freq: f * 2, at, level: 0.07, attack: 0.002, decay: 0.045, pan, wet: 0.35 }),
      );
    });
    return end;
  },

  /* A sparkle for the name: three high sines, staggered, each lifting a
   * little as it fades, over a breath of the very top of the noise. */
  brand: (v) => {
    let end = 0;
    [E7, GS7, B7].forEach((f, i) => {
      end = Math.max(
        end,
        tone(v, {
          type: 'sine', freq: f, to: f * 1.03, glide: 0.04, at: i * 0.05,
          level: 0.2 - i * 0.03, attack: 0.0015, decay: 0.045, pan: (i - 1) * 0.35, wet: 0.35,
        }),
      );
    });
    end = Math.max(end, hiss(v, { filter: 'highpass', freq: 7000, level: 0.045, attack: 0.01, decay: 0.03, wet: 0.3 }));
    return end;
  },

  /* A major arpeggio, E5 G#5 B5 E6, a hundred milliseconds apart, the last
   * note held and given its octave: about half a second. */
  success: (v) => {
    const notes = [E5, GS5, B5, E6];
    let end = 0;
    notes.forEach((f, i) => {
      const at = i * 0.1;
      const last = i === notes.length - 1;
      const decay = last ? 0.13 : 0.06;
      const pan = -0.3 + i * 0.2;
      end = Math.max(
        end,
        tone(v, { type: 'triangle', freq: f, at, level: last ? 0.34 : 0.28, attack: 0.003, decay, pan, wet: 0.45 }),
        tone(v, { type: 'sine', freq: f, at, level: 0.12, attack: 0.003, decay, pan, wet: 0.45 }),
      );
      if (last) {
        end = Math.max(end, tone(v, { type: 'sine', freq: f * 2, at, level: 0.08, attack: 0.002, decay: 0.09, pan, wet: 0.4 }));
      }
    });
    return end;
  },

  /* Something set down: a low sine drooping through 120 Hz, a breath of air
   * darkening as it settles, and the faintest click of contact. */
  drop: (v) =>
    Math.max(
      tone(v, { type: 'sine', freq: 150, to: 96, glide: 0.08, level: 0.55, attack: 0.002, decay: 0.09 }),
      hiss(v, { filter: 'lowpass', freq: 900, to: 260, glide: 0.18, q: 0.7, level: 0.2, attack: 0.006, decay: 0.07 }),
      hiss(v, { filter: 'bandpass', freq: 2400, level: 0.06, attack: 0.0005, decay: 0.003 }),
    ),

  /* Air moving past: a band of noise sweeping up and to the left, then down
   * and to the right, two hundred milliseconds. */
  whoosh: (v) =>
    Math.max(
      hiss(v, { filter: 'bandpass', freq: 500, to: 2600, glide: 0.11, q: 1.6, level: 0.26, attack: 0.06, decay: 0.04, pan: -0.35 }),
      hiss(v, { filter: 'bandpass', freq: 2200, to: 600, glide: 0.1, q: 1.6, level: 0.2, at: 0.09, attack: 0.03, decay: 0.04, pan: 0.35 }),
    ),
};

/* ---- play() ------------------------------------------------------------ */

const lastAt: Partial<Record<SoundName, number>> = {};
/** When each sounding voice ends, in performance.now() ms; pruned on every play. */
let ends: number[] = [];

/**
 * Play a sound. Safe to call anywhere, any time — on the server, before the
 * first gesture, while muted, in a hidden tab, forty times in a frame — and
 * it never throws. See the notes at the top for what makes it a no-op.
 */
export function play(name: SoundName, opts?: PlayOptions): void {
  if (typeof window === 'undefined' || !ctx || !bus || !noise) return;
  if (!isEnabled() || document.hidden) return;
  if (ctx.state !== 'running') {
    /* Waking up (Safari resumes asynchronously even inside a gesture): keep
     * the one sound that matters and play it the moment we are running. A
     * hover is not worth keeping. */
    if (name !== 'hover') pending = { name, opts, at: performance.now() };
    return;
  }
  const design = DESIGNS[name];
  if (!design) return;

  const now = performance.now();
  if (now - (lastAt[name] ?? -Infinity) < MIN_GAP_MS) return;
  ends = ends.filter((e) => e > now);
  if (ends.length >= MAX_VOICES) return;
  lastAt[name] = now;

  const v: Voice = {
    c: ctx,
    out: bus,
    wet: reverb,
    noise,
    t0: ctx.currentTime + LOOKAHEAD_S,
    level: clamp(opts?.gain ?? 1, 0, 2),
    rate: clamp(opts?.rate ?? 1, 0.25, 4),
  };
  try {
    const end = design(v);
    ends.push(now + (end - ctx.currentTime) * 1000);
  } catch {
    /* A node this browser lacks, or a context closed under us: silence, not an error. */
  }
}

/* ---- Helpers for controls ---------------------------------------------- */

interface HoverProps {
  onPointerEnter: (e: { pointerType?: string }) => void;
}

/* One handler per name, so a spread does not hand a memoised control a new function every render. */
const hoverCache = new Map<SoundName, HoverProps>();

/**
 * `{ onPointerEnter }` that plays `name` — spread it onto any control for a
 * hover sound: `<Link {...soundProps('hover')} …>`. A finger does not hover,
 * so touch is ignored. Only usable where a function can be passed, i.e. from
 * a client component; from a server component use `soundAttrs()` instead.
 */
export function soundProps(name: SoundName, opts?: PlayOptions): HoverProps {
  if (!opts) {
    const cached = hoverCache.get(name);
    if (cached) return cached;
  }
  const props: HoverProps = {
    onPointerEnter: (e) => {
      if (e.pointerType === 'touch') return;
      play(name, opts);
    },
  };
  if (!opts) hoverCache.set(name, props);
  return props;
}

/**
 * The same hover sound as a `data-sound` attribute, for controls rendered by
 * a server component (a function prop cannot cross to a client component;
 * a string can). One delegated `pointerover` listener on `window` plays it.
 */
export function soundAttrs(name: SoundName): { 'data-sound': SoundName } {
  return { 'data-sound': name };
}

function onPointerOver(e: PointerEvent) {
  if (e.pointerType === 'touch') return;
  const target = e.target;
  if (!(target instanceof Element)) return;
  const el = target.closest('[data-sound]');
  if (!el) return;
  /* Moving between children of the control is not entering it. */
  const from = e.relatedTarget;
  if (from instanceof Node && el.contains(from)) return;
  const name = el.getAttribute('data-sound');
  if (name && (SOUND_NAMES as readonly string[]).includes(name)) play(name as SoundName);
}

/* ---- Wiring, once, in the browser -------------------------------------- */

if (typeof window !== 'undefined') {
  installGestures();
  window.addEventListener('storage', onStorage);
  window.addEventListener('pointerover', onPointerOver, { passive: true });
}
