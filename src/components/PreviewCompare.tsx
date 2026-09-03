'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { sceneIsLite } from '@/lib/scene-tier';
import EngagementRail from '@/components/EngagementRail';
import { play } from '@/lib/sound';
import { splitFor, subscribeMotion, type Motion } from '@/lib/stage-motion';
import type { Engagement } from '@/lib/engagement';

/*
 * One phone, one video, a slider down the middle.
 *
 * WHY ONE VIDEO ELEMENT AND NOT TWO
 * Two <video> elements have two clocks and drift within seconds; nudging
 * currentTime to correct it never quite looks right. Here the clean side IS the
 * video element and the crushed side is a canvas drawing FROM that same element,
 * so the halves cannot disagree about which frame it is. Sync is structural, not
 * maintained. It also halves the decode cost, which matters on a phone.
 *
 * WHY THE CANVAS IS SIZED BY RATIO, NOT BY PIXELS
 * The obvious implementation draws the crushed side at TikTok's actual delivery
 * resolution — 720 on the short edge — and it is invisible. The phone mock is
 * about 300 CSS pixels wide, so a 720px canvas is still 2.4x sharper than the
 * screen showing it, and both halves look identical. Absolute pixels are the
 * wrong unit at preview scale.
 *
 * What is true at every scale is the RATIO: TikTok turns 2160 into 720, a 3x
 * linear reduction, throwing away 8/9ths of the detail. So the canvas is sized to
 * apply that same reduction relative to the display size — 3x fewer pixels across
 * the width actually on screen. That is an honest rendering of the same loss, and
 * unlike a blur it is a real downscale-and-upscale, which is what a lower
 * rendition physically is.
 *
 * The frame rate is simulated the same way: each frame is held for the full
 * 1/30s interval, so motion is genuinely sampled at the lower rate.
 *
 * ENGAGEMENT NUMBERS ARE ILLUSTRATIVE and labelled as such under the frame.
 * They sit in a feed-style rail down the right edge (EngagementRail) and climb
 * as the handle moves toward the clean side. Deliberately generic chrome — no
 * TikTok logo, wordmark or copied iconography.
 *
 * THE FRAME IS NOT HERE
 * The app page mounts this inside the site's Stage, which puts it in the same
 * phone the landing page uses (Phone3D: bezel, ring, notch, thickness, the
 * hand behind it, the tilt), so this component is the screen and nothing
 * else. `wrapRef` is the screen itself, so the canvas sizing and the drag maths
 * measure the picture and not the frame. The note that used to sit under the
 * bezel is exported separately as `PreviewNote` for the page to place beneath
 * the stage: rendered here it would land inside the phone.
 *
 * WHAT THE STAGE ASKS OF IT
 * `onPositionChange` reports the split so the stage can light the phone and
 * the hand by it; `motionDrive` lets the reader's motion — the pointer's place
 * across the page, or the phone's roll — move the split while nobody is
 * dragging. Both are optional and the slider is unchanged without them.
 *
 * NO FILTER ON THE SCREEN
 * The crushed side used to carry a CSS filter (a little desaturation and
 * contrast loss, the look of a re-encode) and the handle a backdrop blur.
 * Inside the stage's 3D context neither can be composited on its own: the
 * browser re-rasterises the whole context — video included — every frame
 * (Holograms.tsx records the two-frames-a-second version of this). The same
 * look is now applied by the 2D context as it draws, on a canvas a few hundred
 * pixels wide, at most `targetFps` times a second; where a browser has no
 * `ctx.filter` the downscale alone carries the comparison, which is the honest
 * part anyway. The handle is plain glass.
 */

interface Props {
  src: string;
  width: number;
  height: number;
  fps: number;
  bitrateMbps: number;
  crushedLikes: number;
  pristineLikes: number;
  handle?: string;
  sound?: string;
  targetShortEdge?: number;
  targetFps?: number;
  /** Called whenever the split moves, with the divider's position in percent. */
  onPositionChange?: (pos: number) => void;
  /**
   * Let the reader's motion move the split while nobody is dragging: `pos`
   * eases toward splitFor(motion.x) on every reading from stage-motion — the
   * pointer's place across the page on a desktop, the phone's roll on a
   * handset. A drag wins while it lasts; a keyboard step lands and holds until
   * the next reading; touch never drives it.
   */
  motionDrive?: boolean;
  /** The figures at the clean end of the rail; the page draws a fresh set per file. */
  pristine?: Engagement;
}

/*
 * Roughly what a phone shows, in physical pixels across. Both renditions are
 * scaled to this before anyone sees them, so it is the denominator that makes
 * the comparison honest.
 */
const PHONE_SCREEN_PX = 1080;
/*
 * What 2.9 Mbps does on top of 720 lines.
 *
 * The delivered rung is 720x1280, but at TikTok's bitrate for it the picture
 * resolves noticeably fewer lines than that: fine detail is smeared by the
 * encoder long before the pixel grid runs out. Modelling the rung as a clean
 * 720-line downscale therefore UNDERSTATES it -- on a phone-sized mockup the
 * result was indistinguishable from the source, which is not what a viewer
 * of the real rendition sees. This factor is the encoder's share: the crushed
 * side is rendered at three fifths of the rung's own resolution, then drawn
 * back up. Still only resolution -- no colour, contrast or brightness change.
 */
const BITRATE_SOFTNESS = 0.6;
/* Shown when the reader's own file will not preview. No audio; it is a picture. */
const PLACEHOLDER_SRC = '/demo/pristine.mp4';
/* How long a file gets to show its first frame before the stand-in steps in. */
const FIRST_FRAME_MS = 6000;

/**
 * How much smaller the crushed side is drawn than the clean one, as a fraction.
 *
 * Relative to the SCREEN, not the source: nobody watches a 4K file at 4K on a
 * phone. Both versions land on a screen about 1080 pixels across, so the real
 * comparison is the delivered rung stretched to that against a source that
 * already fills it. And only ever delivered-against-clean: a 720p source
 * delivered at 720p loses nothing, so a source at or below the rung is drawn
 * at 1 -- pretending otherwise would be a lie in our own favour.
 *
 * Exported so it can be pinned by a test; the landing page and the tool page
 * both draw with it.
 */
export function crushReduction(shortEdge: number, targetShortEdge: number, screenPx = PHONE_SCREEN_PX): number {
  const delivered = Math.min(shortEdge, targetShortEdge);
  const clean = Math.min(shortEdge, screenPx);
  return Math.min(1, delivered / clean);
}


/* Motion drive: the fraction of the remaining distance closed per 60 Hz frame. */
const FOLLOW = 0.12;

/* The chime rings as the split crosses the middle toward Pristine... */
const REVEAL_AT = 50;
/* ...and re-arms only once it has come clearly back, so a pointer resting on
 * the line does not ring it every frame. Mirrors EngagementRail's pop. */
const REARM_ABOVE = 56;

/* The keys a range input steps on; each step is a tick. */
const STEP_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/*
 * `crushedLikes` and `pristineLikes` remain part of Props — the app page passes
 * them — but every count on the rail comes from src/lib/engagement.ts, so they
 * are accepted and not read.
 */
export default function PreviewCompare({
  src, width, height, fps, bitrateMbps,
  handle = '@yourhandle',
  sound = 'original sound — your edit',
  targetShortEdge = 720, targetFps = 30,
  onPositionChange, motionDrive = false, pristine,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /* The renderer's draw, for a redraw between video frames (the handle moved
   * while the clip is paused). Set by the render effect below. */
  const drawRef = useRef<(() => void) | null>(null);
  const [pos, setPos] = useState(50);
  const [dragging, setDragging] = useState(false);
  /*
   * The stand-in. If the reader's own file produces no frame within a few
   * seconds -- a decode the browser will not start, a container it plays
   * badly, a stall on a cold page -- the screen must not sit black. A bundled
   * clip takes its place with a line saying so; the download is unaffected,
   * because the download never depended on the preview.
   */
  const [fallback, setFallback] = useState(false);
  const effectiveSrc = fallback ? PLACEHOLDER_SRC : src;

  /* The renderer lives below commitPos: it reads posRef, and a ref an effect
   * reads must not be written above it (react-hooks/immutability). */


  /*
   * Every change to the split goes through here, and the parent hears about
   * it in the same tick — not from an effect on `pos`, which scheduled a
   * second render from inside React's passive-effect flush on every frame of
   * a drag or a motion-drive (the pattern behind React's "maximum update
   * depth" warning). One batched render per frame instead.
   */
  const posRef = useRef(pos);
  const reportRef = useRef(onPositionChange);
  useEffect(() => { reportRef.current = onPositionChange; }, [onPositionChange]);
  /*
   * The chime, on the crossing toward Pristine, played in the same tick as
   * the crossing rather than from an effect after the paint. Armed while the
   * split is at or past the line on the crushed side, so mounting past it
   * does not ring and the first crossing does; it re-arms only once the split
   * has come clearly back. The rail's pop lands on the same crossing.
   */
  const revealArmed = useRef(pos >= REVEAL_AT);
  /*
   * WHY THE SPLIT IS NOT REACT STATE ON THE WAY THROUGH
   * A drag on a phone fires pointer events at up to 120 a second, and the
   * gyroscope not far behind. Each one used to set state here, re-render this
   * component, and report to the parent -- which re-rendered the whole stage:
   * rail, holograms, plates, phone. That was the drag lag. Now the handle, the
   * divider and the renderer follow every event imperatively (a CSS variable
   * and a scissor), and React and the parent hear about the split at most
   * thirty times a second, which is as often as anything they draw can change
   * visibly.
   */
  const frameHandle = useRef(0);
  const lastReport = useRef(0);
  const commitPos = useCallback((next: number) => {
    posRef.current = next;
    wrapRef.current?.style.setProperty('--split', `${next}%`);
    if (frameHandle.current) return;
    frameHandle.current = requestAnimationFrame(() => {
      frameHandle.current = 0;
      const p = posRef.current;
      drawRef.current?.();
      const now = performance.now();
      if (now - lastReport.current >= 33) {
        lastReport.current = now;
        setPos(p);
        reportRef.current?.(p);
        if (p >= REARM_ABOVE) revealArmed.current = true;
        if (revealArmed.current && p < REVEAL_AT) {
          revealArmed.current = false;
          play('reveal');
        }
      } else {
        /* Too soon for React; make sure the last position still lands. */
        frameHandle.current = requestAnimationFrame(() => {
          frameHandle.current = 0;
          const q = posRef.current;
          lastReport.current = performance.now();
          setPos(q);
          reportRef.current?.(q);
        });
      }
    });
  }, []);
  /* The starting split, once, so a parent that renders from it is not stale. */
  useEffect(() => { reportRef.current?.(posRef.current); }, []);

  const setFromClientX = useCallback((clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    commitPos(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  }, [commitPos]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => { e.preventDefault(); setFromClientX(e.clientX); };
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragging, setFromClientX]);

  /*
   * Follow the reader's motion.
   *
   * Eased rather than snapped — about 12% of the remaining distance per 60 Hz
   * frame, scaled to the real frame time so a 120 Hz display is not twice as
   * stiff — so a hand crossing the page moves the divider like a slow wipe
   * instead of a flicker. A drag wins while it is happening: the effect is
   * re-run with `dragging`, and a drag in progress is not subscribed at all.
   * Touch never drives it (the store ignores fingers); on a phone the readings
   * are the gyroscope's. `posRef` tracks the split between React commits so
   * consecutive frames do not read a stale value.
   */
  useEffect(() => {
    if (!motionDrive || dragging) return;
    let raf = 0;
    let last = 0;
    let target: number | null = null;

    const step = (now: number) => {
      raf = 0;
      if (target === null) return;
      const dt = last ? Math.min(48, now - last) : 16.7;
      last = now;
      const p = posRef.current;
      const k = 1 - Math.pow(1 - FOLLOW, dt / 16.7);
      const next = Math.abs(target - p) < 0.06 ? target : p + (target - p) * k;
      commitPos(next);
      if (next !== target) raf = requestAnimationFrame(step);
      else last = 0;
    };
    /* A pointer puts the divider where the pointer is, measured across the
     * screen itself — one edge of the phone to the other, as a drag would —
     * and holds at that end past either edge. A gyroscope is the roll. */
    const targetFor = (m: Motion) => {
      const el = wrapRef.current;
      if (m.source === 'pointer' && el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) {
          const clientX = ((m.x + 1) / 2) * window.innerWidth;
          return Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100));
        }
      }
      return splitFor(m.x);
    };
    const unsubscribe = subscribeMotion((m) => {
      // The store's first call is whatever it last saw; before anyone has
      // moved, that is nothing, and nothing should not move the split.
      if (m.source === 'none') return;
      target = targetFor(m);
      if (!raf && !document.hidden) raf = requestAnimationFrame(step);
    });

    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
    };
  }, [motionDrive, dragging, commitPos]);

  /*
   * THE RENDERER. One WebGL canvas, one frame upload, two draws.
   *
   * WHY NOT 2D CANVASES
   * Two 2D canvases drawn from the same frame fixed the sync and broke two
   * other things: a canvas is a fixed grid of pixels, so the clean half was
   * capped at the size it was drawn at and looked soft or blocky where the
   * page showed it larger -- the <video> element never had that problem,
   * because the compositor samples it at the screen's own resolution -- and
   * copying a full 4K frame into a large 2D canvas twice per frame is slow
   * enough on an ordinary GPU to drop to half rate. So the clean side was
   * sharp and smooth only as a video element, and in sync only as a canvas.
   *
   * WebGL gives both. The frame is uploaded to a texture ONCE, which on a
   * hardware-decoded video is a copy that never leaves the GPU. The clean
   * half is that texture drawn at the screen's full device resolution -- as
   * many pixels as the box has, whatever the page did to it. The crushed
   * half is the same texture rendered into a small target at the reduction
   * that is the whole argument, then drawn back up, scissored to the left of
   * the handle. Two full-screen quads per frame is nothing; 60fps at 4K is
   * the default, not an achievement. And both halves are the same frame, by
   * construction, as before.
   *
   * Mipmaps (WebGL2) do the downscaling properly: linear sampling alone at
   * 7:1 shimmers. Where only WebGL1 exists the sampling is linear and the
   * picture a little harsher; where WebGL is missing altogether the canvas
   * stays transparent and the video element underneath shows on its own --
   * no crushed half, but never a black screen.
   */
  useEffect(() => {
    const v = videoRef.current;
    const c = canvasRef.current;
    const wrap = wrapRef.current;
    if (!v || !c || !wrap) return;
    const isFallback = effectiveSrc === PLACEHOLDER_SRC;
    /*
     * BOTH HALVES ON THE CANVAS, ON EVERY DEVICE.
     *
     * A phone tier briefly left the clean half as the native video element
     * with only the crushed half drawn, updated every other frame: cheaper,
     * and the crushed half sat up to a frame behind. It was noticed, and sync
     * has been the one property that must not give. So the phone draws both
     * halves from the one uploaded frame like the desktop does; what it saves
     * instead is fill: the canvas is capped at 2x on a lite device, where a 3x
     * screen would otherwise ask for more than twice the pixels for a picture
     * this size to no visible gain.
     */
    const lite = sceneIsLite();

    const gl2 = c.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
    const gl = (gl2 ?? c.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false })) as WebGLRenderingContext | null;
    const mips = !!gl2;

    let raf = 0;
    let vfc = 0;
    let framesDrawn = 0;
    const rvfc = v as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    const hasVfc = typeof rvfc.requestVideoFrameCallback === 'function';

    /* ---- the programme: a quad, a texture, cover-crop UVs ---- */
    let prog: WebGLProgram | null = null;
    /*
     * PING-PONG, AND WHY. Each presented frame is uploaded ONCE, into A on
     * even frames and B on odd. The clean half samples whichever was uploaded
     * last -- the full frame rate. The crushed half samples A only, so it holds
     * every frame for two: the rung's 30fps, shown honestly, and since A is a
     * frame of the very same sequence it can never be more than that one
     * deliberate frame behind.
     */
    let texA: WebGLTexture | null = null;
    let texB: WebGLTexture | null = null;
    let frameNo = 0;
    /*
     * ADAPTIVE. The renderer times its own uploads. A phone that cannot carry
     * a 4K upload and mip chain sixty times a second is stepped down to every
     * other presented frame -- both halves at 30, still in step -- rather than
     * left to stutter and drag. Once stepped down it stays down: flapping
     * between rates is worse than either.
     */
    let costEma = 0;
    let costSamples = 0;
    let halfRate = false;
    let cbNo = 0;
    let quad: WebGLBuffer | null = null;
    let uScale: WebGLUniformLocation | null = null;
    let uOffset: WebGLUniformLocation | null = null;
    let uSplit: WebGLUniformLocation | null = null;
    let uBias: WebGLUniformLocation | null = null;
    /* Mip levels down from the base for the crushed half: log2 of the
     * reduction, so a half-size picture is one level, a quarter two. */
    let bias = 0;
    let W = 0, H = 0;
    let uvScale: [number, number] = [1, 1];
    let uvOffset: [number, number] = [0, 0];

    if (gl) {
      const vs = `attribute vec2 a; varying vec2 uv; varying vec2 sp; uniform vec2 s; uniform vec2 o;
        void main(){ sp = a * 0.5 + 0.5; uv = sp * s + o; gl_Position = vec4(a, 0.0, 1.0); }`;
      /*
       * highp where the GPU has it. Fragment shaders default to mediump, and
       * on mobile GPUs mediump is a 10-bit mantissa -- not enough to address
       * a 3840-texel texture accurately, so the sample position wanders and a
       * 4K frame comes out soft and slightly blocky. Desktop GPUs run mediump
       * at full precision, which is why the same code looked right on a PC.
       */
      /*
       * ONE DRAW, ONE TEXTURE, BOTH HALVES.
       *
       * Left of the split the fragment samples a coarser mip level of the very
       * same texture (a LOD bias), which is a box-filtered downscale drawn back
       * up -- the same picture the render-target pass produced, without the
       * pass. Right of the split it samples the base level. The two halves are
       * therefore one draw call. `held` is the frame stream held at half rate
       * (see the ping-pong below): the crushed half is the rung's 30fps and can
       * never be more than that one deliberate frame behind the clean half,
       * because both come from the same upload sequence. `split` is in screen
       * fractions; `bias` in mip levels.
       */
      const fs = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 uv; varying vec2 sp; uniform sampler2D clean; uniform sampler2D held; uniform float split; uniform float bias;
        void main(){
          if (sp.x < split) gl_FragColor = texture2D(held, uv, bias);
          else gl_FragColor = texture2D(clean, uv);
        }`;
      const sh = (type: number, src: string) => {
        const h = gl.createShader(type)!;
        gl.shaderSource(h, src); gl.compileShader(h);
        return h;
      };
      prog = gl.createProgram()!;
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(prog);
      gl.useProgram(prog);
      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const aLoc = gl.getAttribLocation(prog, 'a');
      gl.enableVertexAttribArray(aLoc);
      gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
      uScale = gl.getUniformLocation(prog, 's');
      uOffset = gl.getUniformLocation(prog, 'o');
      uSplit = gl.getUniformLocation(prog, 'split');
      uBias = gl.getUniformLocation(prog, 'bias');
      gl.uniform1i(gl.getUniformLocation(prog, 'clean'), 0);
      gl.uniform1i(gl.getUniformLocation(prog, 'held'), 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);

      const mkTex = (min: number) => {
        const t = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return t;
      };
      texA = mkTex(mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      texB = mkTex(mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    }

    /* ---- sizes: the screen's own device pixels, transforms included ---- */
    const size = () => {
      if (!v.videoWidth) return;
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, lite ? 2 : 3);
      let w = Math.max(16, Math.round((r.width || wrap.clientWidth || 300) * dpr));
      let h = Math.max(16, Math.round((r.height || wrap.clientHeight || 650) * dpr));
      /* Bounded, so a 4K monitor at 3x does not ask for a 12-megapixel canvas. */
      const cap = 4_200_000;
      if (w * h > cap) { const k = Math.sqrt(cap / (w * h)); w = Math.round(w * k); h = Math.round(h * k); }
      W = w; H = h;
      c.width = W; c.height = H;
      const reduction = crushReduction(Math.min(v.videoWidth, v.videoHeight), targetShortEdge);
      /* The crushed half's resolution as a fraction of the base, expressed
       * as mip levels below it. */
      bias = Math.max(0, -Math.log2(Math.max(0.05, reduction * BITRATE_SOFTNESS)));
      /* Cover-crop the video into the box, the way object-fit: cover does. */
      const boxA = W / H;
      const vidA = v.videoWidth / v.videoHeight;
      if (vidA > boxA) { const sx = boxA / vidA; uvScale = [sx, 1]; uvOffset = [(1 - sx) / 2, 0]; }
      else { const sy = vidA / boxA; uvScale = [1, sy]; uvOffset = [0, (1 - sy) / 2]; }
      draw();
    };

    /* One frame: upload once (into A or B), draw once. */
    let uploaded = -1;
    const draw = () => {
      if (!gl || !prog || !texA || !texB || v.readyState < 2 || W === 0) return;
      gl.useProgram(prog);
      let latest = frameNo % 2 === 0 ? texB : texA;   // the one uploaded last time
      if (v.currentTime !== uploaded || framesDrawn === 0) {
        const t0 = performance.now();
        const target = frameNo % 2 === 0 ? texA : texB;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, target);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
        if (mips) gl.generateMipmap(gl.TEXTURE_2D);
        uploaded = v.currentTime;
        frameNo++;
        latest = target;
        const cost = performance.now() - t0;
        costEma = costSamples === 0 ? cost : costEma * 0.9 + cost * 0.1;
        costSamples++;
        if (!halfRate && costSamples >= 24 && costEma > 12) halfRate = true;
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, latest);
      gl.activeTexture(gl.TEXTURE1);
      /* Held: the even-frame texture -- or, stepped down to half rate, the
       * latest, since both halves are then at 30 anyway. */
      gl.bindTexture(gl.TEXTURE_2D, halfRate ? latest : texA!);
      gl.viewport(0, 0, W, H);
      gl.uniform2f(uScale, uvScale[0], uvScale[1]);
      gl.uniform2f(uOffset, uvOffset[0], uvOffset[1]);
      gl.uniform1f(uSplit, Math.max(0, Math.min(1, posRef.current / 100)));
      gl.uniform1f(uBias, mips ? bias : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      framesDrawn++;
      c.dataset.frames = String(framesDrawn);
      c.dataset.rate = halfRate ? 'half' : 'full';
    };
    drawRef.current = draw;

    const onFrame = () => {
      cbNo++;
      if (!halfRate || cbNo % 2 === 0) draw();
      vfc = rvfc.requestVideoFrameCallback!(onFrame);
    };
    const tick = () => { draw(); raf = requestAnimationFrame(tick); };

    /*
     * `play()` is rejected more often than the autoplay rules suggest -- iOS Low
     * Power Mode, Data Saver, a backgrounded tab. A refusal is never final: the
     * next `canplay` and the first touch anywhere both try again.
     */
    let starting = false;
    const start = () => {
      /*
       * No readiness guard. play() on an element that has not buffered yet
       * simply starts it when it can; refusing to call it until readyState
       * says 3 was what left the landing clip black on a phone, where the
       * default preload fetches metadata and nothing more -- so readyState
       * never reached 3, so play() was never called, so nothing was fetched.
       * The autoplay attribute above starts it earlier still; this is the
       * retry.
       */
      if (starting || !v.paused) return;
      starting = true;
      void v.play().catch(() => {}).finally(() => { starting = false; });
    };
    const onGesture = () => { if (v.paused) start(); };
    /* A decode that fails outright gets one reload, after a beat. */
    let reloaded = false;
    const onError = () => {
      if (reloaded) return;
      reloaded = true;
      window.setTimeout(() => { v.load(); start(); }, 800);
    };
    /* The stand-in, if nothing has been drawn by the deadline. Never for the
     * stand-in itself: there is nowhere further to fall. */
    const watchdog = window.setTimeout(() => {
      if (framesDrawn === 0 && !isFallback) setFallback(true);
    }, FIRST_FRAME_MS);

    v.addEventListener('error', onError);
    v.addEventListener('loadedmetadata', size);
    v.addEventListener('loadeddata', draw);
    v.addEventListener('canplay', start);
    document.addEventListener('pointerdown', onGesture, { passive: true, capture: true });
    document.addEventListener('touchstart', onGesture, { passive: true, capture: true });
    if (v.videoWidth) size();
    const ro = new ResizeObserver(size);
    ro.observe(wrap);

    start();
    if (hasVfc) {
      draw();
      vfc = rvfc.requestVideoFrameCallback!(onFrame);
    } else {
      raf = requestAnimationFrame(tick);
    }
    return () => {
      drawRef.current = null;
      window.clearTimeout(watchdog);
      if (raf) cancelAnimationFrame(raf);
      if (vfc && rvfc.cancelVideoFrameCallback) rvfc.cancelVideoFrameCallback(vfc);
      ro.disconnect();
      v.removeEventListener('error', onError);
      v.removeEventListener('loadedmetadata', size);
      v.removeEventListener('loadeddata', draw);
      v.removeEventListener('canplay', start);
      document.removeEventListener('pointerdown', onGesture, { capture: true });
      document.removeEventListener('touchstart', onGesture, { capture: true });
      if (gl) {
        if (texA) gl.deleteTexture(texA);
        if (texB) gl.deleteTexture(texB);
        if (quad) gl.deleteBuffer(quad);
        if (prog) gl.deleteProgram(prog);
      }
    };
  }, [effectiveSrc, targetShortEdge]);

  const crushedSpec = `${Math.round(targetShortEdge)}×${Math.round(targetShortEdge * (height / width))} · ${targetFps}fps · 2.9 Mbps`;
  const pristineSpec = `${width}×${height} · ${fps.toFixed(0)}fps · ${bitrateMbps.toFixed(1)} Mbps`;

  // How far the handle sits toward the clean side: 0 is all crushed, 1 is all
  // clean. Drives the rail; the stage reads the same figure via onPositionChange.
  const t = 1 - pos / 100;

  return (
    <div
      ref={wrapRef}
      onPointerDown={(e) => { setDragging(true); setFromClientX(e.clientX); }}
      className="relative aspect-[9/19.5] w-full touch-none select-none overflow-hidden
                 rounded-[38px] bg-black"
    >
      {/* The source, full size underneath. Kept visible so a mobile browser
          does not pause it, and seen only until the first frame is drawn. */}
      <video
        ref={videoRef}
        src={effectiveSrc}
        muted loop playsInline autoPlay preload="auto"
        className="absolute inset-0 h-full w-full object-cover"
      />

      {/* Both halves, drawn by the renderer from one uploaded frame. Transparent
          until the first draw, so the video underneath shows meanwhile. */}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="absolute inset-0 h-full w-full"
      />

      {fallback && (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-3 top-[4.5rem] z-10 rounded-lg border border-white/10 bg-black/75 px-3 py-2 text-center text-[10.5px] leading-snug text-white/85"
        >
          Your file couldn&rsquo;t be shown as a preview here, so this is a stand-in clip.
          Downloading still gives you the full result.
        </div>
      )}

      {/* Legibility wash, top and bottom, over both halves. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/65 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/80 to-transparent" />

      {/* ---- headers: always both visible, so the comparison reads at a glance ---- */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-between gap-2 px-3 pt-8 pb-3">
        <div className="max-w-[46%]">
          <div className="legend text-[8.5px] leading-tight text-white/55">Without Pristine</div>
          <div className="tabular mt-1 text-[9.5px] leading-tight text-white/75">{crushedSpec}</div>
        </div>
        <div className="max-w-[52%] text-right">
          <div className="legend text-[8.5px] leading-tight text-accent-soft">With Pristine</div>
          <div className="tabular mt-1 text-[9.5px] font-medium leading-tight text-white">{pristineSpec}</div>
        </div>
      </div>

      {/* ---- engagement rail: a feed's right rail, lit by how much clean side shows ---- */}
      <EngagementRail t={t} pristine={pristine} className="absolute right-2.5 bottom-[88px]" />

      {/* ---- caption: the same post either way, so it spans both halves ---- */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3.5">
        <div className="text-[12px] font-semibold text-white">{handle}</div>
        <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-white/80">
          <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" className="shrink-0">
            <path d="M9 18V6l10-2v12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
            <circle cx="6.5" cy="18" r="2.5" fill="currentColor" />
            <circle cx="16.5" cy="16" r="2.5" fill="currentColor" />
          </svg>
          <span className="truncate">{sound}</span>
        </div>
      </div>

      {/* ---- handle: a hairline that goes out at either end (one whole video,
              no line on it), and a glass disc that stays on the screen at both
              ends so it can always be dragged back ---- */}
      <div
        className="pointer-events-none absolute inset-y-0 -ml-px w-px bg-white/85 shadow-[0_0_12px_rgba(255,255,255,0.5)] transition-opacity duration-150"
        style={{ left: 'var(--split, 50%)', opacity: pos < 0.75 || pos > 99.25 ? 0 : 1 }}
      />
      <div className="pointer-events-none absolute inset-y-0" style={{ left: 'clamp(22px, var(--split, 50%), calc(100% - 22px))' }}>
        <div className="absolute top-1/2 -left-[22px] grid h-11 w-11 -translate-y-1/2 place-items-center
                        rounded-full border border-white/30 bg-white/15 text-white
                        shadow-[0_10px_30px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.3)]">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M9.5 7.5 5 12l4.5 4.5M14.5 7.5 19 12l-4.5 4.5" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </div>
      </div>

      <input
        type="range" min={0} max={100} value={Math.round(pos)}
        onChange={(e) => commitPos(Number(e.target.value))}
        onKeyDown={(e) => { if (STEP_KEYS.has(e.key)) play('tick'); }}
        aria-label="Compare an ordinary upload with Pristine"
        className="absolute inset-x-0 bottom-0 h-10 w-full cursor-ew-resize opacity-0"
      />
    </div>
  );
}

/**
 * The note under the phone: what the preview shows and what it does not.
 * Rendered by the page beneath the stage, not by the screen above, so it
 * never lands inside the frame.
 */
export function PreviewNote({ bitrateMbps }: { bitrateMbps: number }) {
  return (
    <p className="mx-auto mt-6 max-w-xl text-center text-[11.5px] leading-relaxed text-dim">
      Drag to compare. This shows the resolution and frame rate you lose; the drop from{' '}
      <span className="tabular text-muted">{bitrateMbps.toFixed(1)}</span> to{' '}
      <span className="tabular text-muted">2.9 Mbps</span> of compression is not simulated,
      and on real footage it is the larger difference. Like counts are illustrative.
    </p>
  );
}
