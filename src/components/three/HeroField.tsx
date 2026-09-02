'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { getMotion, subscribeMotion } from '@/lib/stage-motion';
import { play } from '@/lib/sound';
import { sceneIsLite } from '@/lib/scene-tier';

/*
 * The engagement rain behind the hero: the reader's numbers going up.
 *
 * WHAT IT DRAWS
 * Hearts, comment bubbles, share arrows and bookmark ribbons — three hundred
 * of them — rise out of the bottom of the hero and leave over the top, then
 * come round again from below. Near ones are big (70–120 px) and white-hot in
 * a wide coloured halo; far ones are small dust. Each has its own speed (the
 * near ones faster, which is the parallax), a sway, a rock, and a breath in
 * scale — hearts beat, twice, like a pulse. The forty-eight nearest drag a
 * soft trail: three fading, shrinking copies of themselves lagging behind on
 * the same path. Eighty tiny four-point sparkles twinkle in and out, most of
 * them beside an icon. Among all that, counters set in the site's mono face
 * (1.2M, 8.4M, +1M …, each beside its icon) rise faster, pop in with an overshoot, grow, fade
 * and respawn low with a new value. When a near icon reaches the top it pops
 * at the surface: a ripple ring and five sparks that splash up and fall back.
 * Every couple of seconds a large +1 pops beside the pointer; a click
 * anywhere in the hero bursts sixteen hearts and twelve sparkles out of it,
 * with the bubble sound a like makes. The camera leans toward the pointer
 * (or the gyroscope, on a phone), so the field parallaxes with depth; nothing
 * follows the pointer directly. Tints come from the iridescent palette and
 * drift round it over twenty seconds, except the like-red kept for a third
 * of the hearts and the amber kept for a share of the bookmarks, which stay
 * what they are. Everything is blended additively so overlaps bloom.
 *
 * The first frame is already full: the icons are laid out through the whole
 * volume at seed time and only RESPAWN from below, because a field that
 * takes ten seconds to fill would be an empty hero to everyone who does not
 * wait.
 *
 * WHY ONE DRAW CALL
 * Every sprite — icon, trail ghost, sparkle, counter, burst heart, ring — is
 * an instance of one unit quad drawn from one texture atlas by one shader.
 * Per instance: a world position, a size, a rotation, a tint with alpha, a
 * "look" (how white the core is, how strong the halo) and the atlas cell to
 * read. The CPU animates ~700 records a frame and uploads them as instanced
 * attributes — 16 floats each, about 45 KB — then issues a single instanced
 * draw. There is no scene graph to walk and no per-object matrix; the whole
 * field is one draw call against a budget of three.
 *
 * WHY THE ATLAS IS BAKED ON A 2D CANVAS
 * Nothing external may load (CSP), so the icons are drawn as Path2D outlines
 * (the same generic geometry the holograms on the phone use) and the counters
 * are set with the canvas text API in the page's mono face. The halo is baked
 * too — a canvas shadow of the same shape, not a runtime blur — because a
 * blur per frame is exactly the cost this page has been burned by before.
 * The atlas keeps the crisp shape in the red channel and the halo in green,
 * so the shader colours them separately: the halo takes the tint, the core
 * leans toward white. The atlas is baked at once with whatever monospace
 * face is available, so the canvas can fade in within the first second, and
 * baked a second time when the page's face reports ready.
 *
 * WHY WORLD UNITS ARE CSS PIXELS
 * The camera sits at z = 1400 with a field of view fitted to the hero's
 * height, so a sprite on the z = 0 plane is exactly as many pixels wide as its
 * size says — the same eye the DOM's `perspective: 1400px` uses for the phone
 * further down. Depth runs from z = −800 (far) to 200 (near); the visible
 * width and height at any depth follow from that, so each sprite wraps inside
 * the region the camera can see AT ITS DEPTH and the field stays full at
 * every viewport size without anything popping in. Icon sizes are tuned in
 * apparent pixels and converted to world units per depth, so "near 70–120 px"
 * means what it says on screen.
 *
 * WHEN IT STOPS
 * Off screen (IntersectionObserver, 200 px margin), when the tab is hidden,
 * or before the atlas is ready, nothing is drawn: the videos below want the
 * GPU more than a rain nobody can see. Under reduced motion the field is laid
 * out once, drawn once and left alone — no rise, no pops, no bursts, no
 * parallax. The canvas fades in over 500 ms on its first real frame.
 *
 * WHEN IT GIVES UP
 * No WebGL, a software renderer (failIfMajorPerformanceCaveat), a 2D canvas
 * that will not give pixels back, a lost context: nothing is drawn and nothing
 * throws. The starfield and the thin ribbons carry the hero. On the server
 * this is an empty div.
 */

type Range = readonly [number, number];

/* ------------------------------------------------------------------ tuning */

/* Camera distance in world units. World units are CSS pixels on the z = 0
 * plane — the same eye as the DOM's `perspective: 1400px`. */
const CAMERA_Z = 1400;
/* The volume the rain occupies, far to near. */
const Z_FAR = -800;
const Z_NEAR = 200;
/* Spawn-depth bias: above 1 sends more of the crowd far away as small dust
 * and keeps the near plane, which sits over the headline, sparse. */
const DEPTH_BIAS = 1.5;
/* Counters, pointer pops and bursts live nearer than most icons so they read. */
const NUMBER_Z: Range = [-300, 200];
const POP_Z: Range = [130, 180];
const BURST_Z: Range = [100, 180];

/* Population. The instance buffer holds all of them at once. */
const N_HEARTS = 26;
const N_BUBBLES = 16;
const N_SHARES = 12;
const N_BOOKMARKS = 12;
const N_NUMBERS = 9;
const N_POPS = 8;
/* Twinkles: tiny four-point sparkles that pop in and out, mostly beside icons. */
const N_TWINKLES = 22;
/* Trails: the TRAIL_LEADERS nearest icons each drag TRAIL_COPIES ghosts of
 * themselves, the j-th lagging (j + 1) × TRAIL_LAG seconds behind on the same
 * path, scaled and dimmed by the j-th entry of these. */
const TRAIL_LEADERS = 8;
const TRAIL_COPIES = 3;
const TRAIL_LAG = 0.22;
const TRAIL_SCALE = [0.86, 0.72, 0.58];
const TRAIL_ALPHA = [0.5, 0.32, 0.18];
/* A click's burst, and how many may be in flight together; the oldest heart
 * is recycled after that. */
const BURST_HEARTS = 16;
const BURST_SPARKS = 12;
const N_BURSTS = 3;
/* What a near icon releases when it reaches the top: one ring and this many
 * sparks. Pools sized for a few exits a second at the lives below. */
const EXIT_SPARKS = 5;
const N_RINGS = 10;
const N_SPARKS = 72;

/* Apparent sizes in CSS px of the crisp shape, at the far plane and the near
 * plane; an icon draws its size along that line by its depth, and the plane
 * that carries it is SHAPE_SHARE larger to hold the halo. */
const ICON_PX_FAR: Range = [9, 16];
const ICON_PX_NEAR: Range = [28, 50];
/* Per kind — hearts, bubbles, shares, bookmarks — since the shapes fill their
 * boxes differently. */
const ICON_KIND_SCALE = [1, 0.95, 0.95, 0.9];
/* Counter planes are 2:1; these are their world widths before the depth
 * factor. Bursts, sparks, twinkles and rings are apparent px like the icons. */
const NUMBER_WIDTH: Range = [88, 128];
const POP_WIDTH: Range = [124, 160];
const BURST_HEART_PX: Range = [40, 72];
const SPARK_PX: Range = [14, 30];
const TWINKLE_PX: Range = [8, 24];
/* A ring starts at this share of its icon's plane and grows to RING_GROW of it. */
const RING_START = 0.5;
const RING_GROW = 3;
/* Rock amplitude per icon kind, radians: hearts and shares rock, bubbles and
 * bookmarks barely. */
const ROT_AMP = [0.24, 0.12, 0.18, 0.1];

/* Rise speed in world px/s, times a factor that runs from far to near: near
 * icons rise faster as well as reading larger, which is the parallax. */
const RISE: Range = [30, 50];
const RISE_DEPTH: Range = [0.5, 1.7];
/* A respawn starts this far, in world px, below the bottom edge at its depth,
 * so a crowd that left together does not come back as a band. */
const SPAWN_GAP: Range = [0, 160];
/* Breathing: ±this in scale, at a rate per icon; hearts beat instead, twice
 * a period, by BEAT_AMP. */
const BREATHE = 0.06;
const BREATHE_RATE: Range = [0.8, 1.6];
const BEAT_PERIOD: Range = [1.0, 1.5];
const BEAT_AMP = 0.1;
/* Seconds for a tint to travel once round the palette. */
const HUE_CYCLE = 20;

const NUMBER_RISE: Range = [55, 95];
const NUMBER_LIFE: Range = [3.5, 6];
const POP_RISE: Range = [70, 110];
const POP_LIFE: Range = [1.3, 1.7];
const BURST_SPEED: Range = [280, 520];
const BURST_LIFE: Range = [1.0, 1.5];
/* Seconds between the large +1s that pop beside the pointer. */
const POP_EVERY: Range = [1.6, 3.4];
/* Exits: only icons at least this near release a ring, and only this share
 * of them, so the top edge fizzes rather than boils. */
const EXIT_NEAR = 0.45;
const EXIT_CHANCE = 0.7;
const RING_LIFE: Range = [0.6, 0.9];
const SPARK_LIFE: Range = [0.5, 0.9];
const SPARK_SPEED: Range = [120, 260];
/* Sparks splash up and fall back at this, world px/s². */
const SPARK_GRAVITY = 320;
const TWINKLE_LIFE: Range = [0.5, 1.4];
/* Share of twinkles that sit beside an icon (bright) rather than free (dim). */
const TWINKLE_HOSTED = 0.75;
const TWINKLE_FREE_ALPHA = 0.45;

/* Halo gain and how white the core is, far … near. */
const HALO: Range = [0.45, 0.85];
const CORE_WHITE: Range = [0.25, 0.7];

/* The camera's lean toward the pointer at full deflection, world px, and its
 * ease per 60 Hz frame (converted to a time constant in the loop). */
const PARALLAX = 110;
const PARALLAX_Y = 70;
const PARALLAX_EASE = 0.08;
/* How far past the visible top at its depth an icon goes before respawning. */
const WRAP_MARGIN = 1.08;

const MAX_DPR = 2;
const MAX_PIXELS = 8_000_000;
/* On a phone: fewer pixels, so a tap's burst does not stutter. */
const MAX_DPR_NARROW = 1.25;
const MAX_PIXELS_NARROW = 2_000_000;
/* 120 Hz screens render every other frame: soft glowing sprites gain nothing
 * above 60 and the videos below would pay for it. */
const MAX_FPS = 60;
/* How long to wait for the mono face before giving up on the second bake. */
const FONT_WAIT_MS = 1500;
const FADE_MS = 500;

/* The four --color-iri-* hues in palette order (the drift runs round this
 * loop), the like-red a feed uses, and the amber of the bookmark hologram.
 * Parsed by hand: THREE.Color would convert them to linear. */
const IRI = ['#ff6ad5', '#b06bff', '#5b8cff', '#4ef0ff'];
const LIKE_RED = '#fe2c55';
const AMBER = '#ffb36b';
const RED_SHARE = 0.35;
const AMBER_SHARE = 0.4;

/* Decorative counter strings, not copy — all in the millions, the way a post
 * that went everywhere reads. Each is baked beside an icon (NUMBER_ICON), so a
 * figure is never a bare number floating in space: it is a like count, a
 * comment count, a share count. Indices 0, 7 and 1 are the pointer pops. */
/* Which icon sits beside each counter: hearts most often, then comments,
 * shares and bookmarks (the KIND_* cells). */
const NUMBER_ICON = [0, 0, 0, 1, 2, 3, 0, 0, 1, 2, 3, 0, 1, 2, 3, 0];
/*
 * Drawn fresh on every load, so the field never shows the same figures twice,
 * and sized to the icon each one sits beside: a heart carries a like count in
 * the millions (1.1M–9M), a bubble, arrow or bookmark carries a count in the
 * hundreds of thousands (100K–999K) — never past a million. The three pops
 * (indices 0, 1 and 7) are fixed. This module only ever runs in the browser
 * (it is loaded with ssr: false), so Math.random here cannot mismatch anything.
 */
function randomCounters(icons: number[]): string[] {
  const out = ['+1M', '+3M'];
  const used = new Set<string>();
  const pick = (icon: number): string => {
    for (;;) {
      const s =
        icon === 0
          ? `${(1.1 + Math.random() * 7.9).toFixed(1)}M`
          : `${Math.round(100 + Math.random() * 899)}K`;
      if (!used.has(s)) {
        used.add(s);
        return s;
      }
    }
  };
  while (out.length < 16) out.push(out.length === 7 ? '+2M' : pick(icons[out.length] ?? 0));
  return out;
}
const NUMBERS = randomCounters(NUMBER_ICON);
/* Three cells per icon kind besides the hearts, weighted alike, so a
 * bookmark or a comment count is a different figure each time it comes up;
 * the pointer pops (0, 1, 7) rarely float on their own. */
const NUMBER_WEIGHT = [1, 1, 3, 2, 2, 2, 3, 1, 2, 2, 2, 3, 2, 2, 2, 3];
/* What pops beside the pointer: mostly +1M, sometimes +2M, rarely +3M. */
const POP_PICKS = [0, 0, 0, 0, 0, 0, 7, 7, 1];
/* The icon's size and left offset inside a counter cell, px. */
const NUMBER_ICON_PX = 66;
const NUMBER_ICON_X = 20;

/* Atlas: two rows of 256 px cells — the four icons, then the sparkle and the
 * ring — and 256×128 counter cells below them, four a row. */
const ATLAS_W = 1024;
const ATLAS_H = 1024;
const ICON_CELL = 256;
const NUM_W = 256;
const NUM_H = 128;
const CELL_NUMBER0 = 8;
/* How much of its cell (and so of its plane) each shape's crisp outline
 * spans; the rest is halo. Sizes above are divided by these. */
const SHAPE_SHARE = 0.58;
const SPARKLE_SHARE = 0.64;
const RING_SHARE = 0.72;
/* Counter type size in the cell, and the widest a string may set before it is
 * shrunk to fit — leaves room for the halo inside the cell. */
const TEXT_PX = 66;
const TEXT_MAX_W = 138;
/* Canvas shadow radii for the halo passes; each pass is a little fainter. */
const ICON_BLUR = [14, 30, 50];
const SPARK_BLUR = [8, 18, 30];
const RING_BLUR = [10, 22, 36];
const TEXT_BLUR = [10, 20, 34];
/* Pushes the shape off the scratch canvas so only its shadow lands on it. */
const SHADOW_OFF = 4096;

/* --------------------------------------------------------------- constants */

/* Icon kinds double as their atlas cells. */
const KIND_HEART = 0;
const KIND_BUBBLE = 1;
const KIND_SHARE = 2;
const KIND_BOOKMARK = 3;
const CELL_SPARKLE = 4;
const CELL_RING = 5;

/* Instance layout: every population is a contiguous run, so the update loop
 * walks each by its behaviour and never asks a record what it is. */
/*
 * Where an icon or counter starts across the width, −1..1. The headline and
 * the copy sit in the left 60% of the hero, so most of the crowd rises up the
 * right side and the rest is spread thin across the text — enough to feel
 * surrounded, not enough to fight the words.
 */
const TEXT_SHELTER = 0.68;
const spawnX = (r: number): number =>
  r < TEXT_SHELTER ? 0.08 + (r / TEXT_SHELTER) * 0.92 : -1 + ((r - TEXT_SHELTER) / (1 - TEXT_SHELTER)) * 1.08;

const N_ICONS = N_HEARTS + N_BUBBLES + N_SHARES + N_BOOKMARKS;
const N_TRAIL = TRAIL_LEADERS * TRAIL_COPIES;
const N_BURST = BURST_HEARTS * N_BURSTS;
const I_ICON = 0;
const I_TRAIL = I_ICON + N_ICONS;
const I_NUMBER = I_TRAIL + N_TRAIL;
const I_POP = I_NUMBER + N_NUMBERS;
const I_TWINKLE = I_POP + N_POPS;
const I_BURST = I_TWINKLE + N_TWINKLES;
const I_SPARK = I_BURST + N_BURST;
const I_RING = I_SPARK + N_SPARKS;
const N = I_RING + N_RINGS;

const TAU = Math.PI * 2;

const between = (r: Range, u: number) => r[0] + (r[1] - r[0]) * u;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* A smooth bump: 1 at c, 0 beyond half-width w either side. */
const bump = (x: number, c: number, w: number) => {
  const v = 1 - Math.abs(x - c) / w;
  return v > 0 ? v * v * (3 - 2 * v) : 0;
};

/* Back-out ease: reaches ~1.18 halfway and settles at 1. The pop. */
const overshoot = (u: number) => {
  if (u >= 1) return 1;
  if (u <= 0) return 0;
  const v = u - 1;
  return 1 + 3.4 * v * v * v + 2.4 * v * v;
};

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

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
const IRI_RGB = IRI.map(rgb);
const RED_RGB = rgb(LIKE_RED);
const AMBER_RGB = rgb(AMBER);
const NUMBER_WEIGHT_TOTAL = NUMBER_WEIGHT.reduce((a, b) => a + b, 0);

/* A cell's uv rectangle (u0, v0, u1, v1). The texture is flipped on upload,
 * the way three does by default, so v runs from the atlas's bottom. */
function cellRect(c: number): [number, number, number, number] {
  let x: number;
  let y: number;
  let w: number;
  let h: number;
  if (c < CELL_NUMBER0) {
    x = (c % 4) * ICON_CELL;
    y = Math.floor(c / 4) * ICON_CELL;
    w = h = ICON_CELL;
  } else {
    const n = c - CELL_NUMBER0;
    x = (n % 4) * NUM_W;
    y = 2 * ICON_CELL + Math.floor(n / 4) * NUM_H;
    w = NUM_W;
    h = NUM_H;
  }
  return [x / ATLAS_W, 1 - (y + h) / ATLAS_H, (x + w) / ATLAS_W, 1 - y / ATLAS_H];
}
const CELLS = Array.from({ length: CELL_NUMBER0 + NUMBERS.length }, (_, c) => cellRect(c));

function warn(message: string, detail?: unknown) {
  if (process.env.NODE_ENV !== 'production') {
    console.warn(`HeroField: ${message}`, detail ?? '');
  }
}

/* ---------------------------------------------------------------- shaders */

/*
 * One unit quad per instance, sized and rotated in view space so it always
 * faces the camera, reading its own cell of the atlas.
 */
const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec2 aSize;
attribute float aRot;
attribute vec4 aTint;
attribute vec2 aLook;
attribute vec4 aCell;
varying vec2 vUv;
varying vec4 vTint;
varying vec2 vLook;
uniform float uScale;

void main() {
  float s = sin(aRot);
  float c = cos(aRot);
  vec2 corner = position.xy * aSize * uScale;
  vec2 offset = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
  mv.xy += offset;
  gl_Position = projectionMatrix * mv;
  vUv = mix(aCell.xy, aCell.zw, uv);
  vTint = aTint;
  vLook = aLook;
}
`;

/*
 * Red is the crisp shape, green the baked halo. The halo carries the tint; the
 * core mixes toward white by the instance's look. The output is premultiplied
 * light with alpha covering its brightest channel, which is what a
 * premultiplied canvas needs to composite correctly; with additive blending
 * that alpha only dims what is behind by as much as this pixel lights it.
 */
const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uAlpha;
varying vec2 vUv;
varying vec4 vTint;
varying vec2 vLook;

void main() {
  vec2 t = texture2D(uMap, vUv).rg;
  float core = t.r;
  float halo = t.g * vLook.y;
  vec3 light = (vTint.rgb * halo + mix(vTint.rgb, vec3(1.0), vLook.x) * core) * vTint.a * uAlpha;
  light = min(light, vec3(1.0));
  float a = max(light.r, max(light.g, light.b));
  gl_FragColor = vec4(light, a);
}
`;

/* ------------------------------------------------------------- the atlas */

/* Shapes are drawn in a unit box (−1…1) that the caller has already scaled
 * and centred. `detail` is false for the halo pass, which wants the solid
 * silhouette without the cut-outs. */
type Shape = (g: CanvasRenderingContext2D, detail: boolean) => void;

/* The four icons: the generic 24-box outlines Holograms.tsx draws on the
 * phone (heart, bubble, share, bookmark), each with the centre of its own
 * box so it sits in the middle of its cell, and a fit for the heart, which
 * is the smallest in its box. */
const ICON_PATHS: readonly { d: string; cx: number; cy: number; fit: number }[] = [
  { d: 'M12 20.8 3.9 12.9a4.8 4.8 0 0 1 6.8-6.8l1.3 1.3 1.3-1.3a4.8 4.8 0 0 1 6.8 6.8Z', cx: 12, cy: 12.75, fit: 1.1 },
  { d: 'M12 3.2C7 3.2 3 6.7 3 11c0 2.4 1.2 4.5 3.1 5.9L5.3 21l4.5-2.4c.7.1 1.4.2 2.2.2 5 0 9-3.5 9-7.8S17 3.2 12 3.2Z', cx: 12, cy: 12.1, fit: 1 },
  { d: 'M13.5 4.5 21 11.2l-7.5 6.7v-4.1c-4.6.1-7.9 1.7-10.5 5.2.6-5.6 4-9.9 10.5-10.7V4.5Z', cx: 12, cy: 11.75, fit: 1 },
  { d: 'M6.5 3.5h11a1 1 0 0 1 1 1V21l-6.5-4-6.5 4V4.5a1 1 0 0 1 1-1Z', cx: 12, cy: 12.25, fit: 1 },
];
/* Eighteen path units — the tallest outline — span the unit box. */
const PATH_UNIT = 2 / 18;

/* Built at bake time: Path2D exists only in a browser. */
function iconShape(k: number): Shape {
  const p = ICON_PATHS[k];
  const path = new Path2D(p.d);
  return (g, detail) => {
    g.scale(PATH_UNIT * p.fit, PATH_UNIT * p.fit);
    g.translate(-p.cx, -p.cy);
    g.fill(path);
    if (detail && k === KIND_BUBBLE) {
      /* Three dots punched out, so a bubble reads as a comment, not a blob. */
      g.globalCompositeOperation = 'destination-out';
      for (const dx of [8.4, 12, 15.6]) {
        g.beginPath();
        g.arc(dx, 11.2, 1.1, 0, TAU);
        g.fill();
      }
      g.globalCompositeOperation = 'source-over';
    }
  };
}

/* A four-point star with a slim waist and a bright dot at its heart. */
const drawSparkle: Shape = (g) => {
  const w = 0.16;
  g.beginPath();
  g.moveTo(0, -1);
  g.lineTo(w, -w);
  g.lineTo(1, 0);
  g.lineTo(w, w);
  g.lineTo(0, 1);
  g.lineTo(-w, w);
  g.lineTo(-1, 0);
  g.lineTo(-w, -w);
  g.closePath();
  g.fill();
  g.beginPath();
  g.arc(0, 0, 0.2, 0, TAU);
  g.fill();
};

/* A ring: the disc minus a smaller one. Both passes draw the ring itself, so
 * its halo is a soft ring and not a glowing disc. */
const drawRing: Shape = (g) => {
  g.beginPath();
  g.arc(0, 0, 1, 0, TAU);
  g.arc(0, 0, 0.84, 0, TAU, true);
  g.fill('evenodd');
};

/*
 * Renders one cell twice — crisp, then as stacked canvas shadows of the same
 * drawing with the drawing itself pushed off the scratch canvas — and packs
 * the two coverages into the atlas: red = core, green = halo, alpha opaque so
 * the browser's premultiplied 2D storage cannot lose the channels.
 */
function bakeCell(
  atlas: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  draw: Shape,
  blurs: readonly number[],
): boolean {
  const core = document.createElement('canvas');
  const glow = document.createElement('canvas');
  core.width = glow.width = w;
  core.height = glow.height = h;
  const cg = core.getContext('2d');
  const gg = glow.getContext('2d');
  if (!cg || !gg) return false;

  cg.save();
  cg.fillStyle = '#fff';
  draw(cg, true);
  cg.restore();

  for (let i = 0; i < blurs.length; i++) {
    gg.save();
    gg.fillStyle = '#fff';
    gg.globalAlpha = 1 - i * 0.22;
    gg.shadowColor = '#fff';
    gg.shadowBlur = blurs[i];
    /* Shadow offsets ignore the transform, so the drawing goes left by the
       offset and its shadow lands back where the drawing would have been. */
    gg.shadowOffsetX = SHADOW_OFF;
    gg.translate(-SHADOW_OFF, 0);
    draw(gg, false);
    gg.restore();
  }

  const c = cg.getImageData(0, 0, w, h).data;
  const l = gg.getImageData(0, 0, w, h).data;
  const out = atlas.createImageData(w, h);
  const o = out.data;
  for (let p = 0; p < o.length; p += 4) {
    o[p] = c[p + 3];
    o[p + 1] = l[p + 3];
    o[p + 2] = 0;
    o[p + 3] = 255;
  }
  atlas.putImageData(out, x, y);
  return true;
}

/* The page's mono face, as next/font exposes it on the root, with the same
 * fallbacks globals.css gives `--font-mono`. */
function monoFamily(): string {
  const fallback = 'ui-monospace, "Cascadia Code", Consolas, monospace';
  let v = '';
  try {
    v = getComputedStyle(document.documentElement).getPropertyValue('--font-mono-face').trim();
  } catch {
    v = '';
  }
  return v ? `${v}, ${fallback}` : fallback;
}

/* Whether the face is in already. False where the API is missing: then the
 * first bake is also the last, which is still a bake. */
function fontLoaded(font: string): boolean {
  try {
    const fonts = document.fonts;
    return !!fonts && typeof fonts.check === 'function' && fonts.check(font);
  } catch {
    return false;
  }
}

function whenFontReady(font: string): Promise<void> {
  try {
    const fonts = document.fonts;
    if (!fonts || typeof fonts.load !== 'function') return Promise.resolve();
    return Promise.race([
      fonts.load(font).then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => window.setTimeout(resolve, FONT_WAIT_MS)),
    ]);
  } catch {
    return Promise.resolve();
  }
}

function bakeAtlas(family: string): HTMLCanvasElement | null {
  const atlas = document.createElement('canvas');
  atlas.width = ATLAS_W;
  atlas.height = ATLAS_H;
  const g = atlas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#000';
  g.fillRect(0, 0, ATLAS_W, ATLAS_H);

  /* A 256 px cell, its shape scaled so the unit box spans `share` of it. */
  const square = (c: number, shape: Shape, share: number, blurs: readonly number[]) =>
    bakeCell(
      g,
      (c % 4) * ICON_CELL,
      Math.floor(c / 4) * ICON_CELL,
      ICON_CELL,
      ICON_CELL,
      (t, detail) => {
        t.translate(ICON_CELL / 2, ICON_CELL / 2);
        t.scale((ICON_CELL * share) / 2, (ICON_CELL * share) / 2);
        shape(t, detail);
      },
      blurs,
    );
  for (let k = 0; k < ICON_PATHS.length; k++) {
    if (!square(k, iconShape(k), SHAPE_SHARE, ICON_BLUR)) return null;
  }
  if (!square(CELL_SPARKLE, drawSparkle, SPARKLE_SHARE, SPARK_BLUR)) return null;
  if (!square(CELL_RING, drawRing, RING_SHARE, RING_BLUR)) return null;

  /* A font the canvas cannot parse is silently ignored and the text comes
     out at 10px sans; checking the size survived catches that. */
  const fontFor = (px: number) => {
    const wanted = `700 ${px}px ${family}`;
    g.font = wanted;
    return g.font.includes(`${px}px`) ? wanted : `700 ${px}px monospace`;
  };
  for (let n = 0; n < NUMBERS.length; n++) {
    const str = NUMBERS[n];
    g.font = fontFor(TEXT_PX);
    const width = g.measureText(str).width;
    const px = width > TEXT_MAX_W ? Math.floor((TEXT_PX * TEXT_MAX_W) / width) : TEXT_PX;
    const font = fontFor(px);
    const ok = bakeCell(
      g,
      (n % 4) * NUM_W,
      2 * ICON_CELL + Math.floor(n / 4) * NUM_H,
      NUM_W,
      NUM_H,
      (t, detail) => {
        /* The icon first, at the left of the cell, in the same white as the
         * digits so the instance tint colours both together. */
        t.save();
        t.translate(NUMBER_ICON_X + NUMBER_ICON_PX / 2, NUM_H / 2);
        t.scale(NUMBER_ICON_PX / 2, NUMBER_ICON_PX / 2);
        iconShape(NUMBER_ICON[n] ?? KIND_HEART)(t, detail);
        t.restore();
        t.font = font;
        t.textAlign = 'left';
        t.textBaseline = 'middle';
        /* Digits sit a touch high of the em middle; nudge them down. */
        t.fillText(str, NUMBER_ICON_X + NUMBER_ICON_PX + 14, NUM_H / 2 + 3);
      },
      TEXT_BLUR,
    );
    if (!ok) return null;
  }
  return atlas;
}

/* ------------------------------------------------------------ the field */

/*
 * `calm` turns the whole field down without touching its motion: 1 is the
 * hero's field, 0.5 is what the tool and the pricing page mount — a third
 * smaller and a good deal fainter, a backdrop to a form rather than a show
 * behind a headline. Two uniforms, so a change never rebuilds anything.
 */
export default function HeroField({ className, calm = 1 }: { className?: string; calm?: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const calmRef = useRef(calm);
  const applyCalmRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    calmRef.current = calm;
    applyCalmRef.current?.();
  }, [calm]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    /* A fresh canvas per mount. The cleanup deliberately loses the context,
       and a canvas keeps one context for life, so React's development
       double-mount must not get the lost one back. */
    const canvas = document.createElement('canvas');
    canvas.style.cssText =
      `position:absolute;inset:0;width:100%;height:100%;display:block;` +
      `opacity:0;transition:opacity ${FADE_MS}ms ease`;
    root.appendChild(canvas);
    /* Flush the starting style so the later change to 1 transitions. */
    void canvas.offsetWidth;

    let gl: THREE.WebGLRenderer | null = null;
    try {
      gl = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        /* A few hundred soft quads have no business waking a discrete GPU. */
        powerPreference: 'low-power',
        /* A software renderer would cost more than the rain is worth. */
        failIfMajorPerformanceCaveat: true,
      });
    } catch {
      gl = null;
    }
    if (!gl) {
      canvas.remove();
      return;
    }
    const renderer = gl;
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 100, 3200);
    camera.position.set(0, 0, CAMERA_Z);

    /* ---- one quad, N instances ---- */
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
        3,
      ),
    );
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.instanceCount = N;

    const aPos = new Float32Array(N * 3);
    const aSize = new Float32Array(N * 2);
    const aRot = new Float32Array(N);
    const aTint = new Float32Array(N * 4);
    const aLook = new Float32Array(N * 2);
    const aCell = new Float32Array(N * 4);
    const instanced = (array: Float32Array, size: number) =>
      new THREE.InstancedBufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage);
    const posAttr = instanced(aPos, 3);
    const sizeAttr = instanced(aSize, 2);
    const rotAttr = instanced(aRot, 1);
    const tintAttr = instanced(aTint, 4);
    const lookAttr = instanced(aLook, 2);
    const cellAttr = instanced(aCell, 4);
    geometry.setAttribute('aPos', posAttr);
    geometry.setAttribute('aSize', sizeAttr);
    geometry.setAttribute('aRot', rotAttr);
    geometry.setAttribute('aTint', tintAttr);
    geometry.setAttribute('aLook', lookAttr);
    geometry.setAttribute('aCell', cellAttr);

    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uMap: { value: null as THREE.Texture | null },
        uScale: { value: 1 },
        uAlpha: { value: 1 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      premultipliedAlpha: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    /* The bounding sphere of a unit quad would cull the whole field. */
    mesh.frustumCulled = false;
    scene.add(mesh);

    /* ---- per-sprite records, structure-of-arrays ---- */
    /* An icon's kind; a trail ghost's copy index. */
    const kind = new Uint8Array(N);
    /* Whether an icon has already popped at the top on this traverse. */
    const exited = new Uint8Array(N);
    const x0 = new Float32Array(N);
    const y = new Float32Array(N);
    const z = new Float32Array(N);
    const vx = new Float32Array(N);
    const vy = new Float32Array(N);
    const size = new Float32Array(N);
    const swayAmp = new Float32Array(N);
    const swayRate = new Float32Array(N);
    const phase = new Float32Array(N);
    const rotAmp = new Float32Array(N);
    const spin = new Float32Array(N);
    /* A breathing rate, or for a heart its beat period. */
    const pulse = new Float32Array(N);
    const bright = new Float32Array(N);
    const life = new Float32Array(N);
    const dur = new Float32Array(N);
    /* Where on the palette loop a tint sits (0…1), or −1 for a fixed colour. */
    const hue = new Float32Array(N);
    /* The icon a ghost or a twinkle follows, or −1. */
    const host = new Int16Array(N);
    /* A ghost's lag in seconds. A twinkle's offset from its host rides in vx, vy. */
    const lag = new Float32Array(N);

    /* ---- state ---- */
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let still = reduce.matches;
    let hidden = document.hidden;
    let inView = false;
    let lost = false;
    let ready = false;
    let seeded = false;
    let cancelled = false;
    let revealed = false;
    let dirty = false;
    let raf = 0;
    let last = 0;
    let time = 0;
    let W = 0;
    let H = 0;
    let texture: THREE.CanvasTexture | null = null;
    let nextPop = 2;
    let popCursor = 0;
    let burstCursor = 0;
    let sparkCursor = 0;
    let ringCursor = 0;
    const cam = { x: 0, y: 0 };
    const ptr = { x: 0, y: 0, t: -1e9, touch: false };
    let down: { id: number; x: number; y: number; t: number } | null = null;
    const rnd = mulberry32(0x50a7);

    /* ---- geometry of the view ---- */
    const nearOf = (zz: number) => (zz - Z_FAR) / (Z_NEAR - Z_FAR);
    const halfW = (zz: number) => ((W / 2) * (CAMERA_Z - zz)) / CAMERA_Z;
    const halfH = (zz: number) => ((H / 2) * (CAMERA_Z - zz)) / CAMERA_Z;
    /* Apparent px per world px at a depth. */
    const persp = (zz: number) => CAMERA_Z / (CAMERA_Z - zz);
    /* The world plane, at a depth, whose shape reads as `px` on screen. */
    const planeFor = (px: number, zz: number, share: number) => px / (share * persp(zz));
    const randomDepth = () => Z_FAR + (Z_NEAR - Z_FAR) * Math.pow(rnd(), DEPTH_BIAS);
    /* A point in the hero, CSS px from its top-left, to world at a depth. */
    const toWorld = (sx: number, sy: number, zz: number) => ({
      x: cam.x + ((sx / W) * 2 - 1) * halfW(zz),
      y: cam.y - ((sy / H) * 2 - 1) * halfH(zz),
    });

    /* ---- record writers ---- */
    const setTint = (i: number, c: readonly [number, number, number]) => {
      aTint[i * 4] = c[0];
      aTint[i * 4 + 1] = c[1];
      aTint[i * 4 + 2] = c[2];
      hue[i] = -1;
    };
    /* The palette at u — any real; it wraps — blended between neighbours, so
       the field reads as a spectrum rather than four flat colours. */
    const paletteInto = (i: number, u: number) => {
      const s = (u - Math.floor(u)) * IRI_RGB.length;
      const k = Math.floor(s);
      const m = s - k;
      const a = IRI_RGB[k];
      const b = IRI_RGB[(k + 1) % IRI_RGB.length];
      aTint[i * 4] = a[0] + (b[0] - a[0]) * m;
      aTint[i * 4 + 1] = a[1] + (b[1] - a[1]) * m;
      aTint[i * 4 + 2] = a[2] + (b[2] - a[2]) * m;
    };
    /* A random spot on the palette; the drift carries it round from there. */
    const setTintIri = (i: number) => {
      hue[i] = rnd();
      paletteInto(i, hue[i]);
    };
    const copyTint = (to: number, from: number) => {
      hue[to] = hue[from];
      aTint[to * 4] = aTint[from * 4];
      aTint[to * 4 + 1] = aTint[from * 4 + 1];
      aTint[to * 4 + 2] = aTint[from * 4 + 2];
    };
    const setLook = (i: number, coreWhite: number, halo: number) => {
      aLook[i * 2] = coreWhite;
      aLook[i * 2 + 1] = halo;
      dirty = true;
    };
    const setCell = (i: number, c: number) => {
      const r = CELLS[c];
      aCell[i * 4] = r[0];
      aCell[i * 4 + 1] = r[1];
      aCell[i * 4 + 2] = r[2];
      aCell[i * 4 + 3] = r[3];
      dirty = true;
    };
    const weightedNumber = () => {
      let pick = rnd() * NUMBER_WEIGHT_TOTAL;
      for (let n = 0; n < NUMBER_WEIGHT.length; n++) {
        pick -= NUMBER_WEIGHT[n];
        if (pick < 0) return n;
      }
      return 0;
    };
    /* Palette by default; like-red for a share of hearts and amber for a share
       of bookmarks, whose cores stay less white so the colour holds. */
    const iconTint = (i: number, k: number, near: number) => {
      const white = between(CORE_WHITE, near);
      const halo = between(HALO, near);
      if (k === KIND_HEART && rnd() < RED_SHARE) {
        setTint(i, RED_RGB);
        setLook(i, white * 0.6, halo);
      } else if (k === KIND_BOOKMARK && rnd() < AMBER_SHARE) {
        setTint(i, AMBER_RGB);
        setLook(i, white * 0.75, halo);
      } else {
        setTintIri(i);
        setLook(i, white, halo);
      }
    };

    /* ---- seeding ---- */
    /* An icon's plane in world px: its apparent size runs from the far range
       to the near range by depth, the same draw serving both so a big icon is
       big at any depth. */
    const iconPlane = (k: number, zz: number, u: number) => {
      const far = between(ICON_PX_FAR, u);
      const px = far + (between(ICON_PX_NEAR, u) - far) * nearOf(zz);
      return planeFor(px * ICON_KIND_SCALE[k], zz, SHAPE_SHARE);
    };

    /* Where a traverse starts: below the visible bottom at its depth, plane
       and all, plus a gap so a crowd that left together never returns as one. */
    const respawnLow = (i: number) => {
      const zz = z[i];
      x0[i] = spawnX(rnd()) * halfW(zz) * 1.05;
      y[i] = -halfH(zz) - size[i] * 0.5 - between(SPAWN_GAP, rnd());
      exited[i] = 0;
    };

    /* Scattered through the whole volume, so the first frame is already full. */
    const seedIcon = (i: number, k: number) => {
      kind[i] = k;
      const zz = randomDepth();
      const near = nearOf(zz);
      z[i] = zz;
      size[i] = iconPlane(k, zz, rnd());
      x0[i] = spawnX(rnd()) * halfW(zz) * 1.05;
      y[i] = (rnd() * 2 - 1) * (halfH(zz) + size[i] * 0.5);
      exited[i] = y[i] > halfH(zz) - size[i] * 0.1 ? 1 : 0;
      vy[i] = between(RISE, rnd()) * between(RISE_DEPTH, near);
      swayAmp[i] = (8 + 18 * rnd()) * (0.5 + 0.8 * near);
      swayRate[i] = 0.25 + 0.5 * rnd();
      phase[i] = rnd() * TAU;
      rotAmp[i] = ROT_AMP[k];
      pulse[i] = k === KIND_HEART ? between(BEAT_PERIOD, rnd()) : between(BREATHE_RATE, rnd());
      bright[i] = 0.4 + 0.6 * near;
      setCell(i, k);
      iconTint(i, k, near);
    };

    /* The nearest icons lead the trails. Each ghost takes its leader's cell
       and a look of its own — a dim core in a strong halo — so a trail reads
       as a smear of light behind the icon, not as three more icons. */
    const seedTrails = () => {
      const order = Array.from({ length: N_ICONS }, (_, i) => I_ICON + i).sort((a, b) => z[b] - z[a]);
      for (let s = 0; s < TRAIL_LEADERS; s++) {
        const leader = order[s];
        for (let j = 0; j < TRAIL_COPIES; j++) {
          const g = I_TRAIL + s * TRAIL_COPIES + j;
          host[g] = leader;
          kind[g] = j;
          lag[g] = (j + 1) * TRAIL_LAG;
          z[g] = z[leader] - 2;
          hue[g] = -1;
          setCell(g, kind[leader]);
          setLook(g, 0.15, 1.35);
        }
      }
    };

    /* `initial` lays a counter out mid-flight for the first frame; a respawn
       starts low, after a short random delay so they never chain. */
    const seedNumber = (i: number, initial: boolean) => {
      const zz = between(NUMBER_Z, rnd());
      const near = nearOf(zz);
      z[i] = zz;
      size[i] = between(NUMBER_WIDTH, rnd()) * (0.8 + 0.4 * near);
      x0[i] = spawnX(rnd()) * halfW(zz) * 0.95;
      y[i] = initial ? (rnd() * 2 - 1) * halfH(zz) : -halfH(zz) * (0.5 + 0.55 * rnd());
      vy[i] = between(NUMBER_RISE, rnd());
      dur[i] = between(NUMBER_LIFE, rnd());
      life[i] = initial ? 0.12 + 0.55 * rnd() : -rnd() * 0.5;
      bright[i] = 0.6 + 0.4 * near;
      setCell(i, CELL_NUMBER0 + weightedNumber());
      setTintIri(i);
      setLook(i, 0.7, 0.95);
    };

    /* A twinkle sits beside a bright icon most of the time — it rides that
       icon's position, so it stays beside it as it rises — and otherwise
       floats free in the volume, dimmer. `initial` starts it mid-life. */
    const seedTwinkle = (i: number, initial: boolean) => {
      let h = -1;
      if (rnd() < TWINKLE_HOSTED) {
        for (let tries = 0; tries < 4 && h < 0; tries++) {
          const c = I_ICON + Math.floor(rnd() * N_ICONS);
          if (nearOf(z[c]) >= 0.35) h = c;
        }
      }
      host[i] = h;
      let zz: number;
      if (h >= 0) {
        zz = z[h] + 3;
        const r = size[h] * 0.55;
        vx[i] = (rnd() * 2 - 1) * r;
        vy[i] = (rnd() * 2 - 1) * r;
        bright[i] = 0.7 + 0.3 * rnd();
      } else {
        zz = randomDepth();
        x0[i] = (rnd() * 2 - 1) * halfW(zz);
        y[i] = (rnd() * 2 - 1) * halfH(zz);
        bright[i] = TWINKLE_FREE_ALPHA * (0.6 + 0.4 * rnd());
      }
      z[i] = zz;
      size[i] = planeFor(between(TWINKLE_PX, rnd()), zz, SPARKLE_SHARE);
      dur[i] = between(TWINKLE_LIFE, rnd());
      life[i] = initial ? rnd() : 0;
      phase[i] = rnd() * TAU;
      spin[i] = (rnd() - 0.5) * 1.5;
      setCell(i, CELL_SPARKLE);
      setTintIri(i);
      setLook(i, 0.95, 1.1);
    };

    /* Pops, burst hearts, sparks and rings start parked: finished, sized to
       nothing, with the cell they will draw when thrown. */
    const park = (i: number, cell: number) => {
      life[i] = 1;
      dur[i] = 1;
      size[i] = 0;
      z[i] = 0;
      setCell(i, cell);
      setTint(i, [0, 0, 0]);
      setLook(i, 0.4, 1);
    };

    const seedAll = () => {
      /* The icon runs, in the order they sit in the buffer. */
      const runs = [
        [KIND_HEART, N_HEARTS],
        [KIND_BUBBLE, N_BUBBLES],
        [KIND_SHARE, N_SHARES],
        [KIND_BOOKMARK, N_BOOKMARKS],
      ];
      let next = I_ICON;
      for (const [k, n] of runs) {
        for (let j = 0; j < n; j++) seedIcon(next++, k);
      }
      seedTrails();
      for (let i = 0; i < N_NUMBERS; i++) seedNumber(I_NUMBER + i, true);
      for (let i = 0; i < N_POPS; i++) park(I_POP + i, CELL_NUMBER0);
      for (let i = 0; i < N_TWINKLES; i++) seedTwinkle(I_TWINKLE + i, true);
      for (let i = 0; i < N_BURST; i++) park(I_BURST + i, KIND_HEART);
      for (let i = 0; i < N_SPARKS; i++) park(I_SPARK + i, CELL_SPARKLE);
      for (let i = 0; i < N_RINGS; i++) park(I_RING + i, CELL_RING);
    };

    /* The hero's box in the viewport, and a viewport point's place in it. */
    const localPoint = (cx: number, cy: number) => {
      const rect = root.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      const sx = cx - rect.left;
      const sy = cy - rect.top;
      if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) return null;
      return { sx, sy };
    };

    /* ---- spawners ---- */
    const spawnPop = () => {
      const p = localPoint(ptr.x, ptr.y);
      if (!p) return;
      const i = I_POP + (popCursor++ % N_POPS);
      const zz = between(POP_Z, rnd());
      const w = toWorld(p.sx, p.sy, zz);
      z[i] = zz;
      x0[i] = w.x + (rnd() - 0.5) * 100;
      y[i] = w.y + 10 + rnd() * 30;
      vy[i] = between(POP_RISE, rnd());
      size[i] = between(POP_WIDTH, rnd());
      dur[i] = between(POP_LIFE, rnd());
      life[i] = 0;
      bright[i] = 1;
      setCell(i, CELL_NUMBER0 + POP_PICKS[Math.floor(rnd() * POP_PICKS.length)]);
      setTintIri(i);
      setLook(i, 0.75, 1.15);
    };

    /* A spark thrown from a point at a depth: a small palette sparkle that
       spins as it flies. Where it goes is the caller's. */
    const throwSpark = (x: number, yy: number, zz: number, angle: number, speed: number, px: number) => {
      const s = I_SPARK + (sparkCursor++ % N_SPARKS);
      z[s] = zz + 6;
      x0[s] = x;
      y[s] = yy;
      vx[s] = Math.cos(angle) * speed;
      vy[s] = Math.sin(angle) * speed;
      size[s] = planeFor(px, zz, SPARKLE_SHARE);
      dur[s] = between(SPARK_LIFE, rnd());
      life[s] = 0;
      phase[s] = rnd() * TAU;
      spin[s] = (rnd() - 0.5) * 7;
      setTintIri(s);
      setLook(s, 0.9, 1.2);
    };

    /* An icon reaching the top pops at the surface: a ring in its tint where
       it went, and sparks that splash up and fall back into view. */
    const releaseAt = (i: number, x: number, yy: number) => {
      const zz = z[i];
      const r = I_RING + (ringCursor++ % N_RINGS);
      z[r] = zz + 4;
      x0[r] = x;
      y[r] = yy;
      vy[r] = 40;
      size[r] = size[i] * RING_START;
      dur[r] = between(RING_LIFE, rnd());
      life[r] = 0;
      bright[r] = 0.85;
      copyTint(r, i);
      setLook(r, 0.75, 1.3);
      for (let k = 0; k < EXIT_SPARKS; k++) {
        const angle = Math.PI / 2 + (rnd() - 0.5) * 2.2;
        throwSpark(x + (rnd() - 0.5) * 12, yy, zz, angle, between(SPARK_SPEED, rnd()), between(SPARK_PX, rnd()));
      }
    };

    const burstAt = (cx: number, cy: number) => {
      const p = localPoint(cx, cy);
      if (!p) return;
      /* A click in the field is a like: it should sound like one. */
      play('pop', { gain: 0.6 });
      const zz = between(BURST_Z, rnd());
      const w = toWorld(p.sx, p.sy, zz);
      for (let k = 0; k < BURST_HEARTS; k++) {
        const i = I_BURST + (burstCursor++ % N_BURST);
        const angle = (k / BURST_HEARTS) * TAU + (rnd() - 0.5) * 0.5;
        const speed = between(BURST_SPEED, rnd());
        z[i] = zz + (rnd() - 0.5) * 40;
        x0[i] = w.x + Math.cos(angle) * 8;
        y[i] = w.y + Math.sin(angle) * 8;
        vx[i] = Math.cos(angle) * speed;
        vy[i] = Math.sin(angle) * speed + 60;
        size[i] = planeFor(between(BURST_HEART_PX, rnd()), zz, SHAPE_SHARE);
        dur[i] = between(BURST_LIFE, rnd());
        life[i] = 0;
        spin[i] = (rnd() - 0.5) * 1.6;
        iconTint(i, KIND_HEART, 1);
        setLook(i, aLook[i * 2], 1.3);
      }
      for (let k = 0; k < BURST_SPARKS; k++) {
        const angle = (k / BURST_SPARKS) * TAU + (rnd() - 0.5) * 0.6;
        throwSpark(w.x, w.y, zz, angle, between(BURST_SPEED, rnd()) * 1.25, between(SPARK_PX, rnd()) * 1.3);
      }
    };

    /* ---- one step of the simulation, and the attribute arrays with it ---- */
    /* Everything that moves is written through here. */
    const emit = (i: number, x: number, yy: number, zz: number, w: number, h: number, rot: number, a: number) => {
      const i3 = i * 3;
      aPos[i3] = x;
      aPos[i3 + 1] = yy;
      aPos[i3 + 2] = zz;
      aSize[i * 2] = w;
      aSize[i * 2 + 1] = h;
      aRot[i] = rot;
      aTint[i * 4 + 3] = a;
    };
    const hide = (i: number) => emit(i, 0, 0, 0, 0, 0, 0, 0);

    /* An icon's scale at a time: a breath, or for a heart a double beat —
       the second thump smaller and close behind the first. */
    const iconScale = (i: number, t: number) => {
      if (kind[i] === KIND_HEART) {
        const u = t / pulse[i] + phase[i];
        const f = u - Math.floor(u);
        return 1 + BEAT_AMP * (bump(f, 0.08, 0.09) + 0.6 * bump(f, 0.3, 0.1));
      }
      return 1 + BREATHE * Math.sin(t * pulse[i] + phase[i] * 2.3);
    };

    const updateIcons = (dt: number, t: number) => {
      for (let i = I_ICON; i < I_ICON + N_ICONS; i++) {
        const zz = z[i];
        const hh = halfH(zz);
        const sz = size[i];
        const ph = phase[i];
        const sr = swayRate[i];
        let x = x0[i] + swayAmp[i] * Math.sin(t * sr + ph);
        let yy = y[i] + vy[i] * dt;
        /* The visible top at this depth, a hair inside so the ring shows. */
        if (!exited[i] && yy > hh - sz * 0.1) {
          exited[i] = 1;
          if (nearOf(zz) >= EXIT_NEAR && rnd() < EXIT_CHANCE) releaseAt(i, x, yy);
        }
        if (yy > hh * WRAP_MARGIN + sz * 0.5) {
          respawnLow(i);
          yy = y[i];
          x = x0[i] + swayAmp[i] * Math.sin(t * sr + ph);
        }
        y[i] = yy;
        const rot = rotAmp[i] * Math.sin(t * sr * 0.8 + ph * 1.7);
        const s = sz * iconScale(i, t);
        const a = bright[i] * (0.88 + 0.12 * Math.sin(t * (0.9 + sr) + ph * 3.1));
        emit(i, x, yy, zz, s, s, rot, a);
      }
    };

    /* A ghost is its leader as it was `lag` seconds ago: the rise is linear
       and the sway analytic, so that is arithmetic, not a history buffer.
       After a respawn the ghost sits below the bottom until it catches up. */
    const updateTrails = (t: number) => {
      for (let g = I_TRAIL; g < I_TRAIL + N_TRAIL; g++) {
        const L = host[g];
        const j = kind[g];
        const t2 = t - lag[g];
        const ph = phase[L];
        const sr = swayRate[L];
        const x = x0[L] + swayAmp[L] * Math.sin(t2 * sr + ph);
        const yy = y[L] - vy[L] * lag[g];
        const rot = rotAmp[L] * Math.sin(t2 * sr * 0.8 + ph * 1.7);
        const s = size[L] * iconScale(L, t2) * TRAIL_SCALE[j];
        aTint[g * 4] = aTint[L * 4];
        aTint[g * 4 + 1] = aTint[L * 4 + 1];
        aTint[g * 4 + 2] = aTint[L * 4 + 2];
        emit(g, x, yy, z[g], s, s, rot, bright[L] * TRAIL_ALPHA[j]);
      }
    };

    /* Counters and pointer pops: one contiguous run, the pops just after. */
    const updateNumbers = (dt: number) => {
      for (let i = I_NUMBER; i < I_POP + N_POPS; i++) {
        let l = life[i] + dt / dur[i];
        if (l >= 1) {
          if (i < I_POP) {
            seedNumber(i, false);
            l = life[i];
          } else {
            l = 1;
          }
        }
        life[i] = l;
        if (l < 0 || l >= 1) {
          hide(i);
          continue;
        }
        y[i] += vy[i] * dt;
        const w = size[i] * overshoot(l / 0.12) * (1 + 0.28 * l);
        const a = bright[i] * smooth(0, 0.07, l) * (1 - smooth(0.55, 1, l));
        emit(i, x0[i], y[i], z[i], w, w * 0.5, 0, a);
      }
    };

    /* In fast, out slow, squared so it reads as a glint rather than a fade. */
    const updateTwinkles = (dt: number, t: number) => {
      for (let i = I_TWINKLE; i < I_TWINKLE + N_TWINKLES; i++) {
        let l = life[i] + dt / dur[i];
        if (l >= 1) {
          seedTwinkle(i, false);
          l = 0;
        }
        life[i] = l;
        const e = l < 0.25 ? l / 0.25 : 1 - (l - 0.25) / 0.75;
        const env = e * e;
        const h = host[i];
        let x: number;
        let yy: number;
        if (h >= 0) {
          x = aPos[h * 3] + vx[i];
          yy = aPos[h * 3 + 1] + vy[i];
        } else {
          x = x0[i];
          yy = y[i];
        }
        const s = size[i] * (0.5 + 0.5 * env);
        emit(i, x, yy, z[i], s, s, phase[i] + t * spin[i], bright[i] * env);
      }
    };

    const updateParticles = (dt: number, t: number) => {
      /* Burst hearts: thrown outward, damped, then carried up like the rest. */
      for (let i = I_BURST; i < I_BURST + N_BURST; i++) {
        const l = life[i] + dt / dur[i];
        life[i] = l;
        if (l >= 1) {
          hide(i);
          continue;
        }
        const f = Math.exp(-3.2 * dt);
        vx[i] *= f;
        vy[i] = vy[i] * f + 150 * dt;
        x0[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
        const s = size[i] * overshoot(l / 0.1) * (1 - 0.3 * l);
        emit(i, x0[i], y[i], z[i], s, s, spin[i] * l, 1 - smooth(0.5, 1, l));
      }
      /* Sparks: thrown, dragged, pulled back down, spinning as they go. */
      for (let i = I_SPARK; i < I_SPARK + N_SPARKS; i++) {
        const l = life[i] + dt / dur[i];
        life[i] = l;
        if (l >= 1) {
          hide(i);
          continue;
        }
        const f = Math.exp(-2.5 * dt);
        vx[i] *= f;
        vy[i] = vy[i] * f - SPARK_GRAVITY * dt;
        x0[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
        const s = size[i] * overshoot(l / 0.15) * (1 - 0.45 * l);
        emit(i, x0[i], y[i], z[i], s, s, phase[i] + spin[i] * t, 1 - smooth(0.35, 1, l));
      }
      /* Rings: out fast then slowing, fading, drifting up a little. */
      for (let i = I_RING; i < I_RING + N_RINGS; i++) {
        const l = life[i] + dt / dur[i];
        life[i] = l;
        if (l >= 1) {
          hide(i);
          continue;
        }
        y[i] += vy[i] * dt;
        const k = 1 - l;
        const e = 1 - k * k * k;
        const s = size[i] * (1 + (RING_GROW / RING_START - 1) * e);
        emit(i, x0[i], y[i], z[i], s, s, 0, bright[i] * k * Math.sqrt(k));
      }
    };

    const update = (dt: number) => {
      const t = time;
      /* The drift: every palette tint moves the same way round the loop, so
         the field stays a spectrum while its colours travel. */
      const drift = t / HUE_CYCLE;
      for (let i = 0; i < N; i++) {
        if (hue[i] >= 0) paletteInto(i, hue[i] + drift);
      }
      updateIcons(dt, t);
      updateTrails(t);
      updateNumbers(dt);
      updateTwinkles(dt, t);
      updateParticles(dt, t);
    };

    const upload = () => {
      posAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
      rotAttr.needsUpdate = true;
      tintAttr.needsUpdate = true;
      if (dirty) {
        lookAttr.needsUpdate = true;
        cellAttr.needsUpdate = true;
        dirty = false;
      }
    };

    const draw = () => {
      upload();
      renderer.render(scene, camera);
      /* The canvas starts transparent and fades up on its first real frame,
         so there is never a pop from empty to lit. */
      if (!revealed) {
        revealed = true;
        canvas.style.opacity = '1';
        if (process.env.NODE_ENV !== 'production') {
          console.debug(`HeroField: ${renderer.info.render.calls} draw call(s) for ${N} sprites`);
        }
      }
    };

    const running = () => ready && seeded && inView && !hidden && !lost && !still;

    /* The still frame has no parallax: the camera sits on the axis. */
    const drawStill = () => {
      cam.x = cam.y = 0;
      camera.position.set(0, 0, CAMERA_Z);
      update(0);
      draw();
    };

    const frame = (now: number) => {
      raf = 0;
      if (!running()) return;
      raf = requestAnimationFrame(frame);
      /* Half rate on a lite device: sprites this soft drifting at 30 read
       * the same as at 60, for half the GPU time. Part of the low-graphics
       * tier with the 1x pixel ratio and the halved intensity below. */
      if (last && now - last < 1000 / (sceneIsLite() ? 30 : MAX_FPS) - 2) return;
      /* Capped so a stall slows the rain for a frame instead of jumping it. */
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      time += dt;

      const m = getMotion();
      const k = 1 - Math.pow(1 - PARALLAX_EASE, dt * 60);
      cam.x += (m.x * PARALLAX - cam.x) * k;
      cam.y += (-m.y * PARALLAX_Y - cam.y) * k;
      camera.position.set(cam.x, cam.y, CAMERA_Z);
      /* Keep looking at the centre: the translation becomes a turn, and the
       * depth reads as depth instead of as a flat slide. */
      camera.lookAt(0, 0, 0);

      if (time >= nextPop) {
        nextPop = time + between(POP_EVERY, rnd());
        /* Only beside a pointer that is actually here: a mouse or pen that
           moved over the hero in the last couple of seconds. */
        if (!ptr.touch && now - ptr.t < 2500) spawnPop();
      }

      update(dt);
      draw();
    };

    /* Start or stop the loop to match the current conditions. */
    const sync = () => {
      if (running()) {
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
      if (still && ready && seeded && inView && !hidden && !lost) drawStill();
    };

    const resize = () => {
      applyCalmRef.current?.();
      const w = root.clientWidth;
      const h = root.clientHeight;
      if (w < 1 || h < 1) return;
      const narrow = window.innerWidth < 700;
      const dpr = Math.min(
        narrow ? MAX_DPR_NARROW : MAX_DPR,
        window.devicePixelRatio || 1,
        Math.sqrt((narrow ? MAX_PIXELS_NARROW : MAX_PIXELS) / (w * h)),
      );
      W = w;
      H = h;
      /* On a lite device (every phone) render at 1x. The field is fill-rate
       * bound -- three hundred additive sprites over the whole hero -- and a 3x
       * phone at full ratio pushes nine times the pixels of the same scene at
       * 1x. The browser scales the canvas up; on sprites this soft, nobody can
       * tell. This is what lets the rain stay on phones at all. */
      renderer.setPixelRatio(sceneIsLite() ? Math.min(dpr, 1) : dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      /* Fitted to the height so world units are CSS px on the z = 0 plane. */
      camera.fov = (2 * Math.atan(h / 2 / CAMERA_Z) * 180) / Math.PI;
      camera.updateProjectionMatrix();
      if (!seeded) {
        seedAll();
        seeded = true;
      }
      /* Setting the size clears the buffer: a still frame is redrawn here, a
         running loop redraws itself on its next tick. */
      sync();
    };

    /* ---- pointer: where it is, and whether a click was a click ---- */
    const onMove = (e: PointerEvent) => {
      ptr.x = e.clientX;
      ptr.y = e.clientY;
      ptr.t = performance.now();
      ptr.touch = e.pointerType === 'touch';
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
    };
    const onUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId || !running()) return;
      /* A drag or a long press is not a click. */
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (dx * dx + dy * dy > 64 || performance.now() - d.t > 600) return;
      burstAt(e.clientX, e.clientY);
    };
    const onCancel = () => {
      down = null;
    };

    const onVisibility = () => {
      hidden = document.hidden;
      sync();
    };
    const onReduce = (e: MediaQueryListEvent) => {
      still = e.matches;
      sync();
    };
    /* three asks for the context back itself; this only pauses meanwhile. */
    const onLost = () => {
      lost = true;
      sync();
    };
    const onRestored = () => {
      lost = false;
      sync();
    };

    /* ---- the atlas: at once, and again when the mono face is in ---- */
    const adopt = (atlas: HTMLCanvasElement) => {
      const tex = new THREE.CanvasTexture(atlas);
      /* Two mask channels, not a colour: no colour-space conversion. */
      tex.colorSpace = THREE.NoColorSpace;
      tex.premultiplyAlpha = false;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      const old = texture;
      texture = tex;
      material.uniforms.uMap.value = tex;
      /* The calm level, applied now and whenever the prop changes. */
      applyCalmRef.current = () => {
        const c = Math.min(1, Math.max(0, calmRef.current)) * (sceneIsLite() ? 0.5 : 1);
        /* A phone's screen is a third the width and no less busy at full
         * strength, so a narrow canvas turns itself down a step further. */
        const w = root.clientWidth;
        const narrow = w > 0 && w < 640 ? 0.62 : 1;
        material.uniforms.uScale.value = (0.6 + 0.4 * c) * (narrow < 1 ? 0.82 : 1);
        material.uniforms.uAlpha.value = (0.4 + 0.6 * c) * narrow;
      };
      applyCalmRef.current();
      old?.dispose();
      ready = true;
      sync();
    };
    const bake = (family: string): boolean => {
      let atlas: HTMLCanvasElement | null = null;
      try {
        atlas = bakeAtlas(family);
      } catch (err) {
        warn('could not bake the atlas', err);
        atlas = null;
      }
      if (cancelled || !atlas) return false;
      adopt(atlas);
      return true;
    };
    const prepare = async () => {
      const family = monoFamily();
      const font = `700 ${TEXT_PX}px ${family}`;
      const had = fontLoaded(font);
      /* The first bake waits for nothing: the counters set in whatever mono
         face is in, and the canvas fades in on this frame. */
      if (!bake(family) || had) return;
      await whenFontReady(font);
      if (cancelled || !fontLoaded(font)) return;
      bake(family);
    };

    /* Subscribing is what installs the pointer (and gyro) listeners; the
       loop reads the latest value itself. */
    const unsubscribe = subscribeMotion(() => {});

    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('pointercancel', onCancel, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    reduce.addEventListener('change', onReduce);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(resize);
      ro.observe(root);
    } else {
      window.addEventListener('resize', resize);
    }

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          inView = entries.some((entry) => entry.isIntersecting);
          sync();
        },
        { rootMargin: '200px 0px' },
      );
      io.observe(root);
    } else {
      inView = true;
    }

    resize();
    void prepare();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      unsubscribe();
      ro?.disconnect();
      io?.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('visibilitychange', onVisibility);
      reduce.removeEventListener('change', onReduce);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      geometry.dispose();
      material.dispose();
      texture?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      aria-hidden
      className={`pointer-events-none absolute inset-0 overflow-hidden${className ? ` ${className}` : ''}`}
    />
  );
}
