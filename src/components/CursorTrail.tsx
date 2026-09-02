'use client';

import { useEffect, useRef } from 'react';
import { stillQuery } from '@/lib/scene-tier';

/*
 * The cursor's wake: glowing hearts — and, less often, a comment bubble, a
 * share arrow, a bookmark — shed along the pointer's path everywhere on the
 * site, each rising and fading in under a second. The same shapes and colours
 * as the hero's click burst and the bloom behind the phone, so the whole site
 * sheds the same feed.
 *
 * ONE CANVAS OVER THE PAGE
 * A fixed, pointer-events-none 2D canvas at the top of the stacking order
 * (under the dialogs), drawn additively so overlaps bloom. Sprites are
 * rasterised once per kind — halo and shape into a small offscreen canvas —
 * and stamped, which is a handful of drawImage calls a frame and nothing the
 * page beneath can feel. The loop runs only while something is alive and
 * stops the moment the last particle has faded.
 *
 * MOUSE ONLY
 * A finger does not hover, and a trail under a scrolling thumb is noise; the
 * pointer type is checked and touch is ignored. Reduced motion sheds nothing.
 */

type Kind = 'heart' | 'comment' | 'bookmark' | 'share';

const PATHS: Record<Kind, string> = {
  heart: 'M12 20.8 3.9 12.9a4.8 4.8 0 0 1 6.8-6.8l1.3 1.3 1.3-1.3a4.8 4.8 0 0 1 6.8 6.8Z',
  comment: 'M12 3.2C7 3.2 3 6.7 3 11c0 2.4 1.2 4.5 3.1 5.9L5.3 21l4.5-2.4c.7.1 1.4.2 2.2.2 5 0 9-3.5 9-7.8S17 3.2 12 3.2Z',
  bookmark: 'M6.5 3.5h11a1 1 0 0 1 1 1V21l-6.5-4-6.5 4V4.5a1 1 0 0 1 1-1Z',
  share: 'M13.5 4.5 21 11.2l-7.5 6.7v-4.1c-4.6.1-7.9 1.7-10.5 5.2.6-5.6 4-9.9 10.5-10.7V4.5Z',
};
const LOOK: Record<Kind, { fill: string; glow: string }> = {
  heart: { fill: '#ff5c8a', glow: '254,44,85' },
  comment: { fill: '#8fe8ff', glow: '78,240,255' },
  bookmark: { fill: '#ffc36b', glow: '255,179,107' },
  share: { fill: '#9db8ff', glow: '91,140,255' },
};
/* Hearts most of the time. */
const KINDS: Kind[] = ['heart', 'heart', 'heart', 'heart', 'heart', 'comment', 'comment', 'share', 'bookmark'];

/* Sprite cell, px; the shape fills SHAPE of it and the halo the rest. */
const SPRITE = 96;
const SHAPE = 0.42;
/* A new particle every this many px of pointer travel. */
const SPACING = 11;
const MAX_ALIVE = 90;
/* Size on screen, px; life, ms; rise, px/s. */
const SIZE = [11, 19] as const;
const LIFE = [560, 900] as const;
const RISE = [18, 48] as const;
const MAX_DPR = 2;

interface P {
  kind: Kind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rot: number;
  spin: number;
  born: number;
  life: number;
}

const between = (r: readonly [number, number]) => r[0] + Math.random() * (r[1] - r[0]);

function sprite(kind: Kind): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE;
  const g = c.getContext('2d');
  if (!g) return c;
  const look = LOOK[kind];
  const half = SPRITE / 2;
  const halo = g.createRadialGradient(half, half, 0, half, half, half);
  halo.addColorStop(0, `rgba(${look.glow},0.55)`);
  halo.addColorStop(0.35, `rgba(${look.glow},0.2)`);
  halo.addColorStop(1, `rgba(${look.glow},0)`);
  g.fillStyle = halo;
  g.fillRect(0, 0, SPRITE, SPRITE);
  const s = (SPRITE * SHAPE) / 24;
  g.translate(half - 12 * s, half - 12 * s);
  g.scale(s, s);
  g.fillStyle = look.fill;
  g.fill(new Path2D(PATHS[kind]));
  return c;
}

export default function CursorTrail() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (typeof window.matchMedia === 'function') {
      if (stillQuery().matches) return;
      if (window.matchMedia('(hover: none)').matches) return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const sprites = {} as Record<Kind, HTMLCanvasElement>;
    for (const k of ['heart', 'comment', 'bookmark', 'share'] as Kind[]) sprites[k] = sprite(k);

    let dpr = 1;
    let w = 0;
    let h = 0;
    const resize = () => {
      dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };
    resize();
    window.addEventListener('resize', resize);

    const alive: P[] = [];
    let raf = 0;
    let lastX = NaN;
    let lastY = NaN;
    let last = 0;

    const frame = (now: number) => {
      raf = 0;
      const dt = last ? Math.min(48, now - last) / 1000 : 0.016;
      last = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = alive.length - 1; i >= 0; i--) {
        const p = alive[i];
        const age = (now - p.born) / p.life;
        if (age >= 1) {
          alive.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy -= 12 * dt;
        p.rot += p.spin * dt;
        /* Quick in, slow out; a little growth then a shrink toward the end. */
        const a = age < 0.15 ? age / 0.15 : 1 - (age - 0.15) / 0.85;
        const s = p.size * (1 + 0.35 * Math.sin(age * Math.PI)) / SHAPE;
        ctx.globalAlpha = a * 0.95;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.drawImage(sprites[p.kind], -s / 2, -s / 2, s, s);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      ctx.globalAlpha = 1;
      if (alive.length) raf = requestAnimationFrame(frame);
      else {
        last = 0;
        ctx.clearRect(0, 0, w, h);
      }
    };

    const spawn = (x: number, y: number, kind?: Kind) => {
      if (alive.length >= MAX_ALIVE) alive.shift();
      alive.push({
        kind: kind ?? KINDS[Math.floor(Math.random() * KINDS.length)],
        x: x + (Math.random() - 0.5) * 8,
        y: y + (Math.random() - 0.5) * 8,
        vx: (Math.random() - 0.5) * 22,
        vy: -between(RISE),
        size: between(SIZE),
        rot: (Math.random() - 0.5) * 0.6,
        spin: (Math.random() - 0.5) * 1.6,
        born: performance.now(),
        life: between(LIFE),
      });
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const x = e.clientX;
      const y = e.clientY;
      if (Number.isNaN(lastX)) {
        lastX = x;
        lastY = y;
        return;
      }
      const dx = x - lastX;
      const dy = y - lastY;
      const d = Math.hypot(dx, dy);
      if (d < SPACING) return;
      /* Fast sweeps shed along the whole path, not just at the end of it. */
      const n = Math.min(4, Math.floor(d / SPACING));
      for (let i = 1; i <= n; i++) spawn(lastX + (dx * i) / n, lastY + (dy * i) / n);
      lastX = x;
      lastY = y;
    };
    const onLeave = () => {
      lastX = NaN;
      lastY = NaN;
    };
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
        alive.length = 0;
      }
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerleave', onLeave);
    document.addEventListener('mouseleave', onLeave);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('mouseleave', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[70]"
    />
  );
}
