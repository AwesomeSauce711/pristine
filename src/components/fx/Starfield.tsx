'use client';

import { useEffect, useRef } from 'react';
import { stillQuery } from '@/lib/scene-tier';
import { subscribeMotion } from '@/lib/stage-motion';

/*
 * The galaxy behind everything.
 *
 * One fixed canvas at z-index 0, behind the page. Content sits above it at
 * z-index 1, so nothing here is ever composited OVER the two autoplaying
 * videos — the note in globals.css records what happened the last time a
 * full-screen layer was.
 *
 * WHAT IT DRAWS
 * A blue-violet nebula and about a thousand stars at real depths. The stars are
 * points in a box in front of a camera and are perspective-projected every
 * frame, so the near ones are larger and brighter and — this is the point —
 * move faster than the far ones when the camera moves. The camera rises with
 * the page (a fixed fraction of the scroll, so near stars slide past at up to
 * ~0.7× page speed and far ones barely stir) and leans a few percent toward
 * the pointer. Each star twinkles on its own phase; a dozen bright ones carry a
 * four-point flare.
 *
 * WHY THE STARS WRAP AT THEIR OWN DEPTH
 * A long page scrolls the camera thousands of pixels, and a fixed box of stars
 * would empty out in the first screen. So each star is wrapped, every frame,
 * into the region the camera can see AT ITS DEPTH plus a margin. Near stars
 * wrap inside a small box, far stars inside a large one, and the field looks
 * endless at every scroll position without anything ever popping into view.
 *
 * WHY THE NEBULA IS A PAINTING
 * It is drawn once, at a quarter of the canvas resolution, from a few dozen
 * overlapping radial gradients: big blue and violet masses, small cloudlets on
 * top, a few dark dust lanes, a vignette. Per frame it is one drawImage, scaled
 * up by the browser — the upscale is the blur. It drifts very slowly and eases
 * a little with the scroll and the pointer, always less than the stars: the
 * furthest thing moves least.
 *
 * WHAT IT COSTS
 * ~1,100 drawImage calls of a 32px sprite and one full-screen blit, at a
 * device-pixel ratio capped at 1.5 and a total of 2.4 million pixels. That is a
 * couple of milliseconds a frame on a laptop and it stops entirely when the tab
 * is hidden. Under reduced motion it draws one frame and stops: the galaxy
 * stays, nothing in it moves, and the scroll does not parallax.
 *
 * Colours are deliberately biased to the blue-white of a real sky, with rare
 * warm stars, so the field reads as the reference — a galaxy — and not as
 * white noise on black.
 */

interface Props {
  /** Star count multiplier: 1 is ~1,100 on a desktop and ~600 on a phone. */
  density?: number;
  className?: string;
}

/* Depths in units where the focal length is one viewport height. */
const NEAR = 0.45;
const FAR = 3.2;
/* Units per second the camera drifts forward. Ambient, not a warp. */
const DRIFT = 0.014;
/* Camera rise per scrolled pixel, measured in pixels at depth 1. */
const SCROLL_PARALLAX = 0.35;
/* How far the camera leans toward the pointer, in units. */
const POINTER_SHIFT = 0.025;
const MAX_DPR = 2;
/* A 4K screen at its native ratio. The sky is one blit and a thousand small
 * sprites a frame; what it must not be is upscaled on a large display. */
const MAX_PIXELS = 17_000_000;
const SPARKLES = 12;
/* Per-star record: x, y, z, size, twinkle phase, twinkle rate. */
const STRIDE = 6;
const SPRITE = 32;
const BG = '#05060c';
/* White, blue-white, warm — as "r,g,b" for the sprite gradients. */
const COLOURS = ['255,255,255', '196,214,255', '255,228,196'];

/* A small deterministic PRNG, so the field is the same on every visit. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* A soft round star, drawn once and scaled to every size it is needed at. */
function makeDot(rgb: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE;
  const g = c.getContext('2d');
  if (!g) return c;
  const r = SPRITE / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, `rgba(${rgb},1)`);
  grad.addColorStop(0.3, `rgba(${rgb},0.9)`);
  grad.addColorStop(0.6, `rgba(${rgb},0.25)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, SPRITE, SPRITE);
  return c;
}

/* A four-point flare: two tapered arms each way, a short diagonal pair, and a
 * bright core, all fading out from the centre. */
function makeCross(): HTMLCanvasElement {
  const px = 96;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  if (!g) return c;
  const r = px / 2;
  const arm = (len: number, w: number, angle: number) => {
    g.save();
    g.translate(r, r);
    g.rotate(angle);
    g.beginPath();
    g.moveTo(-len, 0);
    g.lineTo(0, -w);
    g.lineTo(len, 0);
    g.lineTo(0, w);
    g.closePath();
    g.fill();
    g.restore();
  };
  const fade = g.createRadialGradient(r, r, 0, r, r, r);
  fade.addColorStop(0, 'rgba(255,255,255,1)');
  fade.addColorStop(0.25, 'rgba(220,232,255,0.7)');
  fade.addColorStop(1, 'rgba(180,200,255,0)');
  g.fillStyle = fade;
  arm(r, px * 0.028, 0);
  arm(r, px * 0.028, Math.PI / 2);
  arm(r * 0.42, px * 0.018, Math.PI / 4);
  arm(r * 0.42, px * 0.018, -Math.PI / 4);
  const core = g.createRadialGradient(r, r, 0, r, r, px * 0.14);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.5, 'rgba(230,240,255,0.55)');
  core.addColorStop(1, 'rgba(200,220,255,0)');
  g.fillStyle = core;
  g.fillRect(0, 0, px, px);
  return c;
}

/* The nebula, painted once at a quarter of the canvas size. */
function makeNebula(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) return c;
  const rnd = mulberry32(0x2545f491);
  const L = Math.max(w, h);

  g.fillStyle = BG;
  g.fillRect(0, 0, w, h);

  /* A soft mass of colour centred at (x, y) — fractions of the canvas — with
   * radius r as a fraction of the longer side. Painted only over its own box. */
  const blob = (x: number, y: number, r: number, rgb: string, a: number) => {
    const cx = x * w;
    const cy = y * h;
    const R = r * L;
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0, `rgba(${rgb},${a})`);
    grad.addColorStop(0.45, `rgba(${rgb},${a * 0.38})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(cx - R, cy - R, R * 2, R * 2);
  };

  /* Light adds. The large structures first, then cloudlets over them. */
  g.globalCompositeOperation = 'lighter';
  blob(0.44, 0.44, 0.46, '24,54,132', 0.34);
  blob(0.62, 0.3, 0.38, '58,30,124', 0.32);
  blob(0.3, 0.64, 0.36, '10,58,92', 0.3);
  blob(0.7, 0.68, 0.28, '84,128,240', 0.12);
  blob(0.2, 0.22, 0.3, '40,36,120', 0.22);
  const tints = ['30,70,170', '70,40,150', '20,90,130', '90,140,255', '150,110,255'];
  for (let i = 0; i < 52; i++) {
    blob(
      0.12 + 0.76 * rnd(),
      0.1 + 0.8 * rnd(),
      0.035 + 0.13 * rnd(),
      tints[Math.floor(rnd() * tints.length)],
      0.035 + 0.085 * rnd(),
    );
  }
  /* A few bright cores, where the cloud is lit from inside. */
  for (let i = 0; i < 6; i++) {
    blob(0.3 + 0.4 * rnd(), 0.28 + 0.44 * rnd(), 0.018 + 0.03 * rnd(), '190,212,255', 0.1 + 0.12 * rnd());
  }

  /* Dust lanes take light away, which is what gives a nebula its structure. */
  g.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 11; i++) {
    blob(0.08 + 0.84 * rnd(), 0.08 + 0.84 * rnd(), 0.07 + 0.17 * rnd(), '3,4,10', 0.26 + 0.3 * rnd());
  }

  /* Vignette, so the cloud sits in the middle of the sky rather than on a tile. */
  const v = g.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.22, w * 0.5, h * 0.5, L * 0.72);
  v.addColorStop(0, 'rgba(5,6,12,0)');
  v.addColorStop(1, 'rgba(5,6,12,0.88)');
  g.fillStyle = v;
  g.fillRect(0, 0, w, h);
  return c;
}

export default function Starfield({ density = 1, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const reduce =
      typeof window.matchMedia === 'function'
        ? stillQuery()
        : null;
    let still = reduce?.matches ?? false;
    let hidden = document.hidden;

    let cssW = 0;
    let cssH = 0;
    let W = 0;
    let H = 0;
    let dpr = 1;
    let count = 0;
    let stars = new Float32Array(0);
    let colour = new Uint8Array(0);
    let dots: HTMLCanvasElement[] = [];
    let cross: HTMLCanvasElement | null = null;
    let nebula: HTMLCanvasElement | null = null;
    let nebulaTimer = 0;
    let raf = 0;
    let last = 0;
    let time = 0;
    const cam = { x: 0, y: 0, tx: 0, ty: 0 };
    const rnd = mulberry32(0x5f3759df);

    const seedStar = (i: number) => {
      const o = i * STRIDE;
      const sparkle = i < SPARKLES;
      stars[o] = (rnd() * 2 - 1) * 4;
      stars[o + 1] = (rnd() * 2 - 1) * 4;
      stars[o + 2] = sparkle ? 0.9 + rnd() * 1.1 : NEAR + rnd() * (FAR - NEAR);
      /* Mostly small; the square keeps the big ones rare. */
      stars[o + 3] = sparkle ? 1.2 + rnd() * 0.4 : 0.55 + rnd() * rnd() * 0.9;
      stars[o + 4] = rnd() * Math.PI * 2;
      stars[o + 5] = 0.4 + rnd() * 1.6;
      const c = rnd();
      colour[i] = c < 0.62 ? 0 : c < 0.92 ? 1 : 2;
    };

    const render = (dt: number) => {
      if (!nebula || count === 0 || W === 0) return;
      const f = H;
      const cx = W / 2;
      const cy = H / 2;
      const scroll = still ? 0 : window.scrollY;
      const camX = cam.x;
      const camY = (scroll * dpr * SCROLL_PARALLAX) / f + cam.y;

      ctx.globalAlpha = 1;
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);

      /* The nebula: 16% oversize so it can drift without showing an edge.
       * Its scroll response is soft-capped (tanh) at a few percent of the
       * height — the furthest layer moves least — and it leans away from the
       * pointer opposite to the stars, which is what makes the depth read. */
      const nw = W * 1.16;
      const nh = H * 1.16;
      const nx = -W * 0.08 + Math.sin(time * 0.05) * W * 0.015 - camX * W * 0.4;
      const ny =
        -H * 0.08 - H * 0.06 * Math.tanh(scroll / 1800) + Math.cos(time * 0.04) * H * 0.012 - cam.y * H * 0.4;
      ctx.drawImage(nebula, nx, ny, nw, nh);

      for (let i = 0; i < count; i++) {
        const o = i * STRIDE;
        let z = stars[o + 2] - DRIFT * dt;
        if (z < NEAR) z += FAR - NEAR;
        stars[o + 2] = z;

        /* The camera's view at this depth, plus a quarter margin either way. */
        const rx = ((cx * z) / f) * 1.25 + 0.02;
        const ry = ((cy * z) / f) * 1.25 + 0.02;
        let dx = stars[o] - camX;
        let dy = stars[o + 1] - camY;
        dx -= Math.floor((dx + rx) / (2 * rx)) * 2 * rx;
        dy -= Math.floor((dy + ry) / (2 * ry)) * 2 * ry;

        const inv = f / z;
        const sx = cx + dx * inv;
        const sy = cy + dy * inv;
        const near = (FAR - z) / (FAR - NEAR);
        const d = (0.9 + 2.4 * near) * stars[o + 3] * dpr;
        const tw = 0.72 + 0.28 * Math.sin(time * stars[o + 5] + stars[o + 4]);
        ctx.globalAlpha = (0.22 + 0.78 * near) * tw;
        ctx.drawImage(dots[colour[i]], sx - d, sy - d, d * 2, d * 2);

        if (i < SPARKLES && cross) {
          const s = d * (5 + 3 * near);
          ctx.globalAlpha =
            (0.35 + 0.65 * near) * (0.55 + 0.45 * Math.sin(time * stars[o + 5] * 0.6 + stars[o + 4] * 1.7));
          ctx.drawImage(cross, sx - s, sy - s, s * 2, s * 2);
        }
      }
      ctx.globalAlpha = 1;
    };

    const frame = (now: number) => {
      raf = 0;
      if (hidden || still) return;
      /* Capped so a stall is a slow frame, not a leap. */
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      time += dt;
      const k = 1 - Math.pow(0.92, dt * 60);
      cam.x += (cam.tx - cam.x) * k;
      cam.y += (cam.ty - cam.y) * k;
      render(dt);
      raf = requestAnimationFrame(frame);
    };

    /* Start or stop the loop to match the current conditions. */
    const sync = () => {
      if (!hidden && !still) {
        if (!raf) {
          last = 0;
          raf = requestAnimationFrame(frame);
        }
        return;
      }
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (still) {
        cam.x = cam.y = 0;
        render(0);
      }
    };

    const buildNebula = () => {
      nebula = makeNebula(Math.max(2, Math.ceil(W / 4)), Math.max(2, Math.ceil(H / 4)));
    };

    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (w === cssW && h === cssH && dots.length > 0) return;
      cssW = w;
      cssH = h;
      dpr = Math.min(w < 700 ? 1.25 : MAX_DPR, window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / Math.max(1, w * h)));
      W = Math.max(1, Math.round(w * dpr));
      H = Math.max(1, Math.round(h * dpr));
      canvas.width = W;
      canvas.height = H;
      if (dots.length === 0) {
        dots = COLOURS.map(makeDot);
        cross = makeCross();
      }
      const wanted = Math.round((w < 768 ? 600 : 1100) * Math.max(0, density));
      if (wanted !== count) {
        count = wanted;
        stars = new Float32Array(count * STRIDE);
        colour = new Uint8Array(count);
        for (let i = 0; i < count; i++) seedStar(i);
      }
      /* The painting is the one expensive step, so a burst of resize events
       * (a phone's URL bar coming and going) repaints it once, afterwards. */
      if (!nebula) {
        buildNebula();
      } else {
        window.clearTimeout(nebulaTimer);
        nebulaTimer = window.setTimeout(() => {
          buildNebula();
          if (still) render(0);
        }, 160);
      }
      render(0);
    };

    /* The pointer across the viewport, or the phone's roll and pitch: the
     * same store the stage and the hero field read, so the whole page turns
     * together. */
    const onMotion = (m: { x: number; y: number; source: string }) => {
      if (still || m.source === 'none') return;
      cam.tx = m.x * POINTER_SHIFT;
      cam.ty = m.y * POINTER_SHIFT * 0.6;
    };
    const onVisibility = () => {
      hidden = document.hidden;
      sync();
    };
    const onReduce = (e: MediaQueryListEvent) => {
      still = e.matches;
      sync();
    };

    resize();
    sync();
    window.addEventListener('resize', resize);
    const unsubscribeMotion = subscribeMotion(onMotion);
    document.addEventListener('visibilitychange', onVisibility);
    reduce?.addEventListener?.('change', onReduce);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(nebulaTimer);
      window.removeEventListener('resize', resize);
      unsubscribeMotion();
      document.removeEventListener('visibilitychange', onVisibility);
      reduce?.removeEventListener?.('change', onReduce);
    };
  }, [density]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={className}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        pointerEvents: 'none',
        background: BG,
      }}
    />
  );
}
