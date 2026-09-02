'use client';

import { useEffect, useRef, type CSSProperties } from 'react';

/*
 * A wireframe globe: nine latitude rings and twelve meridians on a 2D canvas.
 *
 * It has two jobs on the landing page. Inline in the hero headline it is a
 * glyph — set between two words at about 0.72em, so anywhere from ~60px on a
 * phone to ~110px on a wide desktop — and beside the proof text it is a 220px
 * decoration. Both are decorative: `aria-hidden`, never focusable, and never
 * allowed to cost the page anything it can feel. That rules out a WebGL
 * context for a glyph-sized sphere; ~1,000 short line segments on a 2D canvas
 * is well inside a frame even beside two autoplaying videos, and the loop
 * stops whenever the globe is off screen or the tab is hidden.
 *
 * ORIENTATION IS A QUATERNION, NOT A YAW AND A PITCH
 * Two angles gimbal-lock as soon as someone drags the globe over a pole, and
 * they cannot express "keep turning about the globe's own axis after the user
 * has tumbled it". One orientation quaternion can. The idle spin is
 * post-multiplied (a turn about the model's own polar axis) and a drag is
 * pre-multiplied (a turn about the screen's axes, trackball style), and the
 * two compose cleanly however far the globe has been thrown.
 *
 * DEPTH IS ALPHA, IN BANDS
 * Wire on the far side is drawn fainter than wire on the near side; that fade
 * is most of what makes a wireframe read as a sphere rather than a doily. A
 * per-segment alpha would be ~1,000 state changes a frame, so segments are
 * sorted into 16 depth bands and each band is one stroke() call. A little
 * perspective (near wire comes out slightly larger than far wire) and a faint
 * top-left light do the rest.
 *
 * TOUCH
 * At rest the globe allows vertical panning and pinch-zoom (`touch-action:
 * pan-y pinch-zoom`): a thumb that lands on the biggest glyph in the headline
 * still scrolls the page, and only a mostly-horizontal swipe is read as a
 * spin. `touch-action: none` is set for the lifetime of an active drag and
 * removed with it. A plain `none` at rest would make the headline a dead zone
 * for scrolling on phones.
 */

interface Props {
  /** Diameter in CSS pixels. Omit to fill the parent, which must then give it
   *  a box (the hero wraps it in a span sized in em). */
  size?: number;
  /** Drag to spin, with inertia; hovering doubles the idle spin. */
  interactive?: boolean;
  className?: string;
  /** `white` strokes white at 70%. `iri` strokes the iridescent palette,
   *  cycling slowly around the sphere. */
  tone?: 'white' | 'iri';
}

const DEG = Math.PI / 180;
const RINGS = 9;
const MERIDIANS = 12;

/* Camera distance in sphere radii. Mild perspective: near wire comes out a
 * little larger than far wire, which is the other half of the depth cue. */
const CAM = 4.2;
/* Where the silhouette sits in depth. A camera at distance D sees the sphere
 * out to z = 1/D, not to the equator; everything behind that is the far side. */
const Z_LIMB = 1 / CAM;

const IDLE_RATE = 14 * DEG; // rad/s
const HOVER_MUL = 2;
/* A thrown globe loses ~93% of its speed a second: long enough to feel like
 * mass, short enough that it is not still turning when the eye has moved on. */
const THROW_DECAY = 2.6; // 1/s
const MAX_THROW = 10; // rad/s
const MIN_THROW = 0.02; // rad/s, below which the throw is over
const BANDS = 16;
/* Unit vector toward the light: above and to the left, slightly in front. */
const LIGHT = [-0.45, 0.6, 0.66] as const;

const IRI_STOPS: [number, string][] = [
  [0, '#ff6ad5'],
  [0.2, '#b06bff'],
  [0.42, '#5b8cff'],
  [0.6, '#4ef0ff'],
  [0.74, '#f4fbff'],
  [0.86, '#ff9ae0'],
  [1, '#ff6ad5'],
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/*
 * Depth → 0..1 through a sigmoid centred on the silhouette, so wire just
 * behind the limb is visibly fainter than wire just in front of it while the
 * two ends of the range stay smooth. Normalised so the near pole is exactly 1.
 */
const FADE_K = 3.2;
const sig = (x: number) => 1 / (1 + Math.exp(-x));
const FADE_LO = sig(-FADE_K * (1 + Z_LIMB));
const FADE_HI = sig(FADE_K * (1 - Z_LIMB));
const depthOf = (z: number) => (sig(FADE_K * (z - Z_LIMB)) - FADE_LO) / (FADE_HI - FADE_LO);

/* Enough samples that no chord sags more than a quarter pixel at that size. */
const samplesFor = (d: number) => (d < 96 ? 32 : d < 180 ? 48 : 72);

/* ------------------------------------------------------------ quaternions */

type Quat = [number, number, number, number]; // x, y, z, w

const qAxis = (x: number, y: number, z: number, angle: number): Quat => {
  const h = angle / 2;
  const s = Math.sin(h);
  return [x * s, y * s, z * s, Math.cos(h)];
};

/* Hamilton product. R(a·b) = R(a)·R(b): b is applied first, then a. */
const qMul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

const qNorm = (q: Quat): Quat => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};

/* Row-major 3×3 rotation matrix, for column vectors: v' = M·v. */
const qMat = (q: Quat): number[] => {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
  ];
};

/* --------------------------------------------------------------- geometry */

interface Geometry {
  /** Ring sample count the geometry was built for. */
  n: number;
  /** Unit-sphere vertices, x/y/z triples, y up. */
  pts: Float32Array;
  /** Polylines into `pts`: rings are closed loops, meridians run pole to pole. */
  lines: { start: number; count: number; closed: boolean }[];
}

function buildGeometry(n: number): Geometry {
  const half = n >> 1;
  const lines: Geometry['lines'] = [];
  const pts = new Float32Array((RINGS * n + MERIDIANS * (half + 1)) * 3);
  let p = 0;

  // Rings every 18° from −72° to +72°: the equator plus four each side.
  for (let i = 1; i <= RINGS; i++) {
    const lat = -Math.PI / 2 + (Math.PI * i) / (RINGS + 1);
    const r = Math.cos(lat);
    const y = Math.sin(lat);
    lines.push({ start: p / 3, count: n, closed: true });
    for (let k = 0; k < n; k++) {
      const lon = (2 * Math.PI * k) / n;
      pts[p++] = r * Math.cos(lon);
      pts[p++] = y;
      pts[p++] = r * Math.sin(lon);
    }
  }

  // Meridians every 30°, each a half-circle from pole to pole.
  for (let j = 0; j < MERIDIANS; j++) {
    const lon = (2 * Math.PI * j) / MERIDIANS;
    const cl = Math.cos(lon);
    const sl = Math.sin(lon);
    lines.push({ start: p / 3, count: half + 1, closed: false });
    for (let k = 0; k <= half; k++) {
      const lat = -Math.PI / 2 + (Math.PI * k) / half;
      const r = Math.cos(lat);
      pts[p++] = r * cl;
      pts[p++] = Math.sin(lat);
      pts[p++] = r * sl;
    }
  }

  return { n, pts, lines };
}

/* -------------------------------------------------------------- component */

export default function Globe({ size, interactive = true, className, tone = 'white' }: Props) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const motionMq =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    let reduced = motionMq?.matches ?? false;

    // Layout size in CSS px. Fractional: an em-sized box rarely lands on a pixel.
    let cssW = 0;
    let cssH = 0;
    let geom: Geometry | null = null;
    // Per-vertex scratch: screen x, screen y, depth z, light term.
    let proj = new Float32Array(0);
    const bands: number[][] = Array.from({ length: BANDS }, (): number[] => []);

    // A desk-globe stance: axis leaning 23.4° to the right, tipped 12° toward
    // the viewer so the polar rings read as ellipses rather than as lines.
    let q: Quat = qNorm(qMul(qAxis(0, 0, 1, -23.4 * DEG), qAxis(1, 0, 0, 12 * DEG)));
    let wx = 0; // throw velocity about the screen's x axis, rad/s
    let wy = 0; // ...and about its y axis
    let spinMul = 1; // eases toward HOVER_MUL while hovered
    let phase = 0; // where the iridescent palette currently sits, radians
    let hovered = false;
    let dragging = false;
    let inView = true;
    let raf = 0;
    let last = 0;
    let pointerId = -1;
    let lastX = 0;
    let lastY = 0;
    let lastT = 0;

    /* Screen-space rotation by `ax` about x and `ay` about y, as one turn
     * about their combined axis (a trackball, not two hinges). */
    const spin = (ax: number, ay: number) => {
      const ang = Math.hypot(ax, ay);
      if (ang < 1e-7) return;
      q = qNorm(qMul(qAxis(ax / ang, ay / ang, 0, ang), q));
    };

    const iriStyle = (cx: number, cy: number, R: number): CanvasGradient => {
      // Conic where available (colour cycles AROUND the sphere); a rotating
      // linear sweep is the fallback for the few browsers still without it.
      const g =
        typeof ctx.createConicGradient === 'function'
          ? ctx.createConicGradient(phase, cx, cy)
          : ctx.createLinearGradient(
              cx + Math.cos(phase) * R, cy + Math.sin(phase) * R,
              cx - Math.cos(phase) * R, cy - Math.sin(phase) * R,
            );
      for (const [at, colour] of IRI_STOPS) g.addColorStop(at, colour);
      return g;
    };

    const draw = () => {
      if (!geom || cssW <= 0 || cssH <= 0) return;
      const d = Math.min(cssW, cssH);
      const lw = clamp(d / 110, 0.75, 1.4);
      const R = d / 2 - lw - 0.5;
      if (R < 2) return;
      const cx = cssW / 2;
      const cy = cssH / 2;
      // Under perspective the silhouette projects slightly outside the sphere's
      // own radius (to 1/√(1 − 1/D²)); this scale lands it exactly on the limb
      // circle drawn last, so the wire never pokes past the ring.
      const k = R * Math.sqrt(1 - 1 / (CAM * CAM));
      const m = qMat(q);

      ctx.setTransform(canvas.width / cssW, 0, 0, canvas.height / cssH, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      // Sheen: a faint glass highlight, top-left, so the sphere has a surface.
      const sheen = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R);
      if (tone === 'iri') {
        sheen.addColorStop(0, 'rgba(190,150,255,0.16)');
        sheen.addColorStop(0.55, 'rgba(120,150,255,0.05)');
        sheen.addColorStop(1, 'rgba(78,240,255,0)');
      } else {
        sheen.addColorStop(0, 'rgba(255,255,255,0.10)');
        sheen.addColorStop(0.6, 'rgba(255,255,255,0.02)');
        sheen.addColorStop(1, 'rgba(255,255,255,0)');
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = sheen;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();

      // Rotate, light and project every vertex once.
      const { pts, lines } = geom;
      for (let i = 0, p = 0; i < pts.length; i += 3, p += 4) {
        const x = pts[i];
        const y = pts[i + 1];
        const z = pts[i + 2];
        const rx = m[0] * x + m[1] * y + m[2] * z;
        const ry = m[3] * x + m[4] * y + m[5] * z;
        const rz = m[6] * x + m[7] * y + m[8] * z;
        const s = k / (1 - rz / CAM);
        proj[p] = cx + rx * s;
        proj[p + 1] = cy - ry * s;
        proj[p + 2] = rz;
        proj[p + 3] = Math.max(0, rx * LIGHT[0] + ry * LIGHT[1] + rz * LIGHT[2]);
      }

      // Sort segments into depth bands by their midpoint.
      for (const band of bands) band.length = 0;
      for (const line of lines) {
        const segs = line.closed ? line.count : line.count - 1;
        for (let s = 0; s < segs; s++) {
          const a = (line.start + s) * 4;
          const b = (line.start + ((s + 1) % line.count)) * 4;
          const depth = depthOf((proj[a + 2] + proj[b + 2]) / 2);
          const lit = (proj[a + 3] + proj[b + 3]) / 2;
          const v = depth * (0.78 + 0.22 * lit);
          const band = bands[clamp(Math.floor(v * BANDS), 0, BANDS - 1)];
          band.push(proj[a], proj[a + 1], proj[b], proj[b + 1]);
        }
      }

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = tone === 'iri' ? iriStyle(cx, cy, R) : '#ffffff';
      const base = tone === 'iri' ? 0.92 : 0.7;
      // Far bands first so the near wire sits on top where they cross.
      for (let i = 0; i < BANDS; i++) {
        const band = bands[i];
        if (band.length === 0) continue;
        const t = (i + 0.5) / BANDS;
        ctx.globalAlpha = base * (0.14 + 0.86 * t);
        ctx.lineWidth = lw * (0.72 + 0.28 * t);
        ctx.beginPath();
        for (let j = 0; j < band.length; j += 4) {
          ctx.moveTo(band[j], band[j + 1]);
          ctx.lineTo(band[j + 2], band[j + 3]);
        }
        ctx.stroke();
      }

      // The limb: the one crisp circle that anchors the glyph in a line of type.
      ctx.globalAlpha = tone === 'iri' ? 0.8 : 0.55;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    /* The loop runs only while there is something to animate AND someone who
     * could see it. Under reduced motion that is only a drag or its throw. */
    const wanted = () =>
      cssW > 0 &&
      cssH > 0 &&
      inView &&
      !document.hidden &&
      (dragging || Math.hypot(wx, wy) > MIN_THROW || !reduced);

    const step = (dt: number) => {
      const target = hovered ? HOVER_MUL : 1;
      spinMul += (target - spinMul) * (1 - Math.exp(-6 * dt));
      if (!dragging) {
        // Idle turn about the globe's OWN polar axis (post-multiplied).
        if (!reduced) q = qMul(q, qAxis(0, 1, 0, IDLE_RATE * spinMul * dt));
        // The throw, about the screen's axes, decaying.
        if (Math.hypot(wx, wy) > MIN_THROW) {
          spin(wx * dt, wy * dt);
          const decay = Math.exp(-THROW_DECAY * dt);
          wx *= decay;
          wy *= decay;
        } else {
          wx = 0;
          wy = 0;
        }
        q = qNorm(q);
      }
      phase += dt * 0.5 * spinMul;
    };

    const tick = (now: number) => {
      raf = 0;
      // Capped so a frame after a long stall is a step, not a leap.
      const dt = clamp((now - last) / 1000, 0, 0.05);
      last = now;
      step(dt);
      draw();
      if (wanted()) raf = requestAnimationFrame(tick);
    };

    const kick = () => {
      if (raf !== 0 || !wanted()) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };

    const fit = (w: number, h: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cssW = w;
      cssH = h;
      const bw = Math.max(1, Math.round(w * dpr));
      const bh = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      const n = samplesFor(Math.min(w, h));
      if (!geom || geom.n !== n) {
        geom = buildGeometry(n);
        proj = new Float32Array((geom.pts.length / 3) * 4);
      }
      draw();
      kick();
    };

    /* ------------------------------------------------------------ pointer */

    const onMove = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== pointerId) return;
      const R = Math.max(1, Math.min(cssW, cssH) / 2);
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      const dt = Math.max(1, e.timeStamp - lastT) / 1000;
      lastX = e.clientX;
      lastY = e.clientY;
      lastT = e.timeStamp;
      // Trackball feel: a drag of one radius turns the globe one radian.
      const ax = dy / R;
      const ay = dx / R;
      spin(ax, ay);
      // Smoothed so a single jittery sample cannot become the throw.
      wx += (clamp(ax / dt, -MAX_THROW, MAX_THROW) - wx) * 0.45;
      wy += (clamp(ay / dt, -MAX_THROW, MAX_THROW) - wy) * 0.45;
    };

    const endDrag = (id: number, at: number) => {
      if (!dragging || id !== pointerId) return;
      dragging = false;
      pointerId = -1;
      // A pointer that stopped moving before it lifted placed the globe; it
      // did not throw it. And under reduced motion nothing coasts.
      if (at - lastT > 90 || reduced) {
        wx = 0;
        wy = 0;
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      canvas.style.touchAction = '';
      canvas.style.cursor = '';
      try {
        if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      } catch {
        // Already released; nothing to undo.
      }
      kick();
    };

    const onUp = (e: PointerEvent) => endDrag(e.pointerId, e.timeStamp);

    const onDown = (e: PointerEvent) => {
      if (dragging) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Stops a text selection starting from the glyph; does NOT stop touch
      // scrolling — that is touch-action's job, below.
      e.preventDefault();
      dragging = true;
      pointerId = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      lastT = e.timeStamp;
      wx = 0;
      wy = 0;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Moves are read from the window either way; capture only keeps the
        // cursor state tidy when the pointer leaves the canvas mid-drag.
      }
      canvas.style.touchAction = 'none';
      canvas.style.cursor = 'grabbing';
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      kick();
    };

    const onEnter = () => {
      hovered = true;
      kick();
    };
    const onLeave = () => {
      hovered = false;
    };

    /* -------------------------------------------------------- lifecycle */

    const onVis = () => kick();
    const onMotion = () => {
      reduced = motionMq?.matches ?? false;
      kick();
    };
    const onResize = () => {
      // Layout changes arrive through the ResizeObserver; this catches a DPR
      // change (zoom, a monitor swap) that leaves the CSS size alone.
      if (size != null) fit(size, size);
      else if (ro) fit(cssW, cssH);
      else fit(wrap.clientWidth, wrap.clientHeight);
    };

    let ro: ResizeObserver | null = null;
    if (size != null) {
      fit(size, size);
    } else if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) fit(entry.contentRect.width, entry.contentRect.height);
      });
      ro.observe(wrap);
    } else {
      fit(wrap.clientWidth, wrap.clientHeight);
    }

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          inView = entries.some((entry) => entry.isIntersecting);
          kick();
        },
        { rootMargin: '80px' },
      );
      io.observe(wrap);
    }

    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
    motionMq?.addEventListener?.('change', onMotion);
    if (interactive) {
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('lostpointercapture', onUp);
      wrap.addEventListener('pointerenter', onEnter);
      wrap.addEventListener('pointerleave', onLeave);
    }

    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
      ro?.disconnect();
      io?.disconnect();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      motionMq?.removeEventListener?.('change', onMotion);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('lostpointercapture', onUp);
      wrap.removeEventListener('pointerenter', onEnter);
      wrap.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      canvas.style.touchAction = '';
      canvas.style.cursor = '';
    };
  }, [size, interactive, tone]);

  /*
   * Sized in px when told, otherwise fills the parent. `aspect-ratio` covers a
   * parent that only gives a width: the percentage height falls back to auto
   * and the ratio makes it square from the width.
   */
  const style: CSSProperties = {
    display: 'inline-block',
    verticalAlign: 'middle',
    width: size ?? '100%',
    height: size ?? '100%',
    aspectRatio: size == null ? '1 / 1' : undefined,
    cursor: interactive ? 'grab' : undefined,
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: interactive ? 'pan-y pinch-zoom' : undefined,
    pointerEvents: interactive ? undefined : 'none',
  };

  return (
    <span ref={wrapRef} aria-hidden className={className} style={style}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
    </span>
  );
}
