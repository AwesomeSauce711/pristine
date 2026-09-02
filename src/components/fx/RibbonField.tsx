'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

/*
 * The hero's iridescent chrome ribbon.
 *
 * WHAT IT DRAWS
 * Three glossy tubes of liquid holographic chrome. The dominant one enters at
 * the top corner and flows down through one third of the hero — the page
 * mounts it mirrored, so it takes the right third that a left-aligned headline
 * leaves empty — and two thinner ones cross behind it. Each is a signed distance to a sine-wave centre line, shaded as a
 * cylinder with a fake normal, coloured by a thin-film cosine palette (pink,
 * violet, blue, cyan and a pale sheen between them), with a white cylindrical
 * highlight and a soft glow. The waves travel down the ribbon, the thickness
 * breathes so it reads as a flat ribbon turning, the whole thing slides with
 * the page on scroll, and it bends slightly toward the pointer.
 *
 * WHY RAW WEBGL
 * This predates three.js arriving in the project (round two brought it in for
 * the hand and the engagement field), and it needs none of it: one fullscreen
 * triangle and one fragment shader is the whole renderer, and it stays that way. GLSL ES 1.0 only, so
 * it runs on every WebGL1 device; no dynamic loops, no derivatives extension.
 *
 * WHY HALF RESOLUTION
 * Everything here is soft-edged or glowing, so the browser's bilinear upscale
 * of a 0.5x buffer is invisible, and it quarters the fragment work. The page
 * has two autoplaying videos further down; the hero should not be the thing
 * that steals their GPU time.
 *
 * WHY THE ANIMATION PHASES ARE COMPUTED HERE, NOT IN THE SHADER
 * The shader is mediump, which on a real 16-bit mobile GPU keeps about three
 * significant digits. A clock in seconds multiplied by a rate inside the
 * shader loses precision as it grows, and the ribbon starts to twitch after a
 * couple of minutes on the page. So the four phases are computed in float64
 * here, wrapped to one period, and handed over already small.
 *
 * WHY A THICKNESS KNOB
 * Round two put the engagement rain (three/HeroField) in the hero and kept
 * the ribbons behind it as thin threads of chrome. `thickness` scales every
 * tube's half-thickness in the shader — one uniform, not three more ribbons —
 * and the glow is derived from that thickness, so thinner also means fainter.
 *
 * WHEN IT STOPS
 * The frame loop runs only while the tab is visible, the hero is on screen,
 * and the reader has not asked for reduced motion. Off screen — which is most
 * of the time once someone starts reading — nothing is drawn at all. Reduced
 * motion draws one good frame and stops: the colour and the gloss survive, the
 * movement does not.
 *
 * WHEN IT GIVES UP
 * No WebGL, a software renderer (failIfMajorPerformanceCaveat), a shader that
 * will not compile, a context that is lost and cannot be rebuilt — every one of
 * those swaps in a static CSS-gradient blob in the same palette. Nothing here
 * throws: on the server it renders an empty canvas, and in the browser a
 * failure is a fallback, never an error boundary.
 */

/* Drawing-buffer pixels per CSS pixel. Injected into the shader as well so the
 * scroll conversion cannot drift out of step with the buffer size. */
const RENDER_SCALE = 0.75;
/* A phone renders the ribbons at half size; they are soft shapes and the
 * difference is invisible, the frame time is not. */
const RENDER_SCALE_NARROW = 0.5;
const renderScale = () => (typeof window !== 'undefined' && window.innerWidth < 700 ? RENDER_SCALE_NARROW : RENDER_SCALE);

/* How far the ribbons slide up per pixel scrolled, on top of the hero itself
 * scrolling. Positive runs ahead of the page and reads as a foreground flow;
 * flipping the sign gives a deeper, lagging parallax instead. */
const SCROLL_DRIFT = 0.5;

/* Pointer easing per 60Hz frame. Converted to a time constant in the loop so a
 * 120Hz screen does not ease twice as fast. */
const POINTER_EASE = 0.06;

/* Animation rates: radians per second for the two waves and the twist, palette
 * units per second for the hue drift (the palette repeats every 2 units). */
const RATE = { wave1: 0.26, wave2: 0.42, twist: 0.55, hue: 0.045 } as const;

/* The moment drawn when motion is off, chosen for a good still composition. */
const STILL_TIME = 3.0;

const TAU = Math.PI * 2;

const VERT = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

/*
 * Screen units: y runs -0.5 (bottom) to 0.5 (top), x is scaled by the aspect
 * ratio so a unit is the same length both ways. Each ribbon's centre line is
 * x = g(y): a drift across the height plus two sines. Its derivative gives the
 * true perpendicular distance and the lateral direction of the tube normal, so
 * the tube keeps its thickness and its highlight where it slopes.
 */
const FRAG = `
precision mediump float;

#define TAU 6.28318530718
#define PX_SCALE 1.0
#define SCROLL_DRIFT ${SCROLL_DRIFT.toFixed(4)}

uniform vec2  uResolution;  /* drawing-buffer size, px */
uniform vec4  uPhase;       /* wave 1, wave 2, twist (radians); hue drift (palette units) */
uniform float uScroll;      /* window.scrollY, CSS px */
uniform vec2  uPointer;     /* eased pointer, -1..1 across the canvas, y up */
uniform float uIntensity;
uniform float uThickness;   /* scales every ribbon's half-thickness */

/* Thin-film palette, period 2: pink, orchid, sky, cyan, aqua, lilac, pink. */
vec3 palette(float t) {
  return vec3(0.64, 0.62, 0.92)
       + vec3(0.36, 0.34, 0.08) * cos(TAU * (0.5 * t + vec3(0.0, 0.45, 0.5)));
}

/* Premultiplied source-over. */
vec4 over(vec4 dst, vec4 src) {
  return src + dst * (1.0 - src.a);
}

struct Rib {
  float x0;      /* centre x where it enters at the top edge */
  float drift;   /* how far the centre moves right, top to bottom */
  float a1;      /* main wave amplitude */
  float k1;      /* main wave frequency, radians per canvas height */
  float f1;      /* main wave phase offset */
  float a2;      /* ripple amplitude */
  float k2;      /* ripple frequency */
  float f2;      /* ripple phase offset */
  float thick;   /* half-thickness of the tube */
  float hue;     /* palette offset */
  float bright;  /* overall brightness */
  float bend;    /* how strongly the pointer pulls it */
};

vec4 ribbon(vec2 p, vec2 pointer, float scrollN, Rib r) {
  float down = 0.5 - p.y;   /* 0 at the top edge, 1 at the bottom */

  /* Centre line and its slope. Phases are subtracted so the waves travel
     downward, the way the ribbon flows; scroll nudges them too. */
  float s1 = r.k1 * down + r.f1 - uPhase.x + scrollN * 1.0;
  float s2 = r.k2 * down + r.f2 - uPhase.y + scrollN * 1.5;
  float xc = r.x0 + r.drift * down + r.a1 * sin(s1) + r.a2 * sin(s2);
  float dx = -(r.drift + r.a1 * r.k1 * cos(s1) + r.a2 * r.k2 * cos(s2));

  /* Pull toward the cursor's x, strongest level with the cursor. Its own
     slope is small enough to leave out of dx. */
  float dy = (p.y - pointer.y) * 2.0;
  xc += (pointer.x - xc) * r.bend * exp(-dy * dy);

  float inv = inversesqrt(1.0 + dx * dx);
  float sd = (p.x - xc) * inv;   /* signed perpendicular distance */
  float d = abs(sd);

  /* The thickness breathes along the length: a flat ribbon seen turning. */
  float w = r.thick * uThickness * (0.78 + 0.22 * sin(down * 5.0 + r.f1 * 3.0 - uPhase.z));

  /* Cylinder normal from the distance: lateral component along the curve's
     normal, z from the circle. */
  float n = min(d / w, 1.0);
  float nz = sqrt(1.0 - n * n);
  vec3 N = vec3(vec2(1.0, -dx) * (inv * n * sign(sd)), nz);

  /* Key light from the upper left gives the long cylindrical highlight; a
     second, softer one from the lower right is the reflection chrome shows
     of the other side of the room; the rim catches the sky. */
  vec3 L = normalize(vec3(-0.45, 0.65, 0.62));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float diff = max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, H), 0.0), 56.0);
  float sheen = pow(max(dot(N, normalize(vec3(0.6, -0.35, 0.7))), 0.0), 9.0);
  float rim = (1.0 - nz) * (1.0 - nz);

  /* Thin film: hue turns with the facing angle, differs edge to edge, and
     slides along the length. */
  float t = r.hue + uPhase.w + 1.1 * (1.0 - nz) + 0.3 * sign(sd) * n + 0.6 * down;
  vec3 col = palette(t) * (0.30 + 0.70 * diff)
           + spec * 1.2
           + palette(t + 0.6) * (sheen * 0.35)
           + palette(t + 0.3) * (rim * 0.4);
  col *= r.bright;

  float aa = 1.25 / uResolution.y;
  float body = 1.0 - smoothstep(w - aa, w + aa, d);
  float glow = 0.30 * exp(-max(d - w, 0.0) / (w * 1.2)) * (1.0 - body);
  vec3 glowCol = palette(r.hue + uPhase.w + 0.5 + 0.6 * down) * r.bright;

  return vec4(col * body + glowCol * glow, body + glow);
}

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  float scrollN = uScroll * PX_SCALE / uResolution.y;

  /* Sampling lower on the curve moves the ribbon up the screen. The pointer
     is shifted the same way so the bend stays level with the cursor. */
  vec2 p = uv;
  p.y -= scrollN * SCROLL_DRIFT;
  vec2 pp = vec2(uPointer.x * 0.5 * aspect, uPointer.y * 0.5 - scrollN * SCROLL_DRIFT);

  /* Thinner on tall phones, where the left third is a narrow strip. */
  float ws = 0.72 + 0.28 * smoothstep(0.45, 1.3, aspect);

  vec4 acc = vec4(0.0);
  /* Farthest first: a faint filament leaning right. */
  acc = over(acc, ribbon(p, pp, scrollN, Rib(
    -0.30 * aspect, 0.26 * aspect,
    0.06 * aspect, 3.4, 2.4,
    0.02 * aspect, 7.3, 0.9,
    0.022 * ws, 1.15, 0.55, 0.05)));
  /* A thinner tube crossing behind the main one, leaning left. */
  acc = over(acc, ribbon(p, pp, scrollN, Rib(
    -0.16 * aspect, -0.24 * aspect,
    0.09 * aspect, 2.1, 4.0,
    0.03 * aspect, 5.2, 1.6,
    0.045 * ws, 0.8, 0.78, 0.08)));
  /* The dominant ribbon: top-left corner, down through the left third. */
  acc = over(acc, ribbon(p, pp, scrollN, Rib(
    -0.40 * aspect, 0.20 * aspect,
    0.11 * aspect, 2.6, 0.4,
    0.035 * aspect, 5.9, 2.1,
    0.085 * ws, 0.0, 1.0, 0.12)));

  /* Dissolve before the bottom edge so the next section is not cut by a
     hard line of chrome. */
  float fade = smoothstep(0.0, 0.16, gl_FragCoord.y / uResolution.y);
  acc = min(acc * (fade * uIntensity), 1.0);
  /* Premultiplied colour must not exceed alpha, or compositing is undefined. */
  acc.rgb = min(acc.rgb, vec3(acc.a));
  gl_FragColor = acc;
}
`;

/* The same four hues as the --color-iri-* tokens, strung down the left third
 * along the path the shader's dominant ribbon takes. No filter: the softness
 * is in the gradient stops, so it costs nothing to scroll. */
const FALLBACK_STYLE: CSSProperties = {
  background: [
    'radial-gradient(38% 30% at 10% 4%, rgba(255,106,213,0.55) 0%, rgba(255,106,213,0) 70%)',
    'radial-gradient(34% 30% at 22% 40%, rgba(176,107,255,0.50) 0%, rgba(176,107,255,0) 70%)',
    'radial-gradient(36% 28% at 28% 72%, rgba(91,140,255,0.45) 0%, rgba(91,140,255,0) 70%)',
    'radial-gradient(30% 24% at 20% 100%, rgba(78,240,255,0.40) 0%, rgba(78,240,255,0) 70%)',
  ].join(', '),
  WebkitMaskImage: 'linear-gradient(#000 80%, transparent)',
  maskImage: 'linear-gradient(#000 80%, transparent)',
};

interface Scene {
  program: WebGLProgram;
  buffer: WebGLBuffer;
  uResolution: WebGLUniformLocation | null;
  uPhase: WebGLUniformLocation | null;
  uScroll: WebGLUniformLocation | null;
  uPointer: WebGLUniformLocation | null;
  uIntensity: WebGLUniformLocation | null;
  uThickness: WebGLUniformLocation | null;
}

function clampIntensity(v: number): number {
  return Number.isFinite(v) ? Math.min(2, Math.max(0, v)) : 1;
}

/* Never zero: the glow falls off over a multiple of the thickness. */
function clampThickness(v: number): number {
  return Number.isFinite(v) ? Math.min(3, Math.max(0.05, v)) : 1;
}

function warn(message: string, detail: string | null | undefined) {
  if (process.env.NODE_ENV !== 'production') {
    console.warn(`RibbonField: ${message}`, detail ?? '');
  }
}

function createContext(canvas: HTMLCanvasElement): WebGLRenderingContext | null {
  const opts: WebGLContextAttributes = {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    /* A quarter-resolution shader has no business waking a discrete GPU. */
    powerPreference: 'low-power',
    /* A software renderer would be slower than the CSS fallback. */
    failIfMajorPerformanceCaveat: true,
  };
  try {
    return (
      canvas.getContext('webgl', opts) ??
      (canvas.getContext('experimental-webgl', opts) as WebGLRenderingContext | null)
    );
  } catch {
    return null;
  }
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    warn('shader failed to compile', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/* Everything that lives on the GL context. Built once, and again after a
 * context restore, because a restored context comes back empty. */
function buildScene(gl: WebGLRenderingContext): Scene | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  if (!vs) return null;
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!fs) {
    gl.deleteShader(vs);
    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  /* Flagged for deletion now; they go when the program does. */
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    warn('program failed to link', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }

  /* One triangle that covers clip space; the fragment shader does the rest. */
  const buffer = gl.createBuffer();
  const aPos = gl.getAttribLocation(program, 'aPos');
  if (!buffer || aPos < 0) {
    if (buffer) gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.useProgram(program);

  return {
    program,
    buffer,
    uResolution: gl.getUniformLocation(program, 'uResolution'),
    uPhase: gl.getUniformLocation(program, 'uPhase'),
    uScroll: gl.getUniformLocation(program, 'uScroll'),
    uPointer: gl.getUniformLocation(program, 'uPointer'),
    uIntensity: gl.getUniformLocation(program, 'uIntensity'),
    uThickness: gl.getUniformLocation(program, 'uThickness'),
  };
}

function destroyScene(gl: WebGLRenderingContext, scene: Scene) {
  gl.deleteBuffer(scene.buffer);
  gl.deleteProgram(scene.program);
}

export default function RibbonField({
  intensity = 1,
  thickness = 1,
  className,
}: {
  intensity?: number;
  /** Scales every ribbon's thickness; 1 is the round-one look, 0.35 is a thread. */
  thickness?: number;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fallback, setFallback] = useState(false);

  /* The frame loop reads intensity and thickness from refs so a prop change
   * does not tear down and rebuild the GL context. A still frame is redrawn
   * on change. */
  const intensityRef = useRef(intensity);
  const thicknessRef = useRef(thickness);
  const redrawRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    intensityRef.current = intensity;
    thicknessRef.current = thickness;
    redrawRef.current?.();
  }, [intensity, thickness]);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;

    let gl: WebGLRenderingContext | null = null;
    let scene: Scene | null = null;
    try {
      gl = createContext(canvas);
      scene = gl && buildScene(gl);
    } catch {
      scene = null;
    }
    if (!gl || !scene) {
      setFallback(true);
      return;
    }
    const ctx = gl;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let still = reduce.matches;
    let hidden = document.hidden;
    let inView = true;
    let lost = false;
    let raf = 0;
    let last = 0;
    let time = 0;
    let width = 0;
    let height = 0;
    let revealed = false;
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

    const running = () => scene !== null && !lost && !still && !hidden && inView;

    const draw = (scroll: number) => {
      if (!scene || lost) return;
      ctx.uniform2f(scene.uResolution, width, height);
      ctx.uniform4f(
        scene.uPhase,
        (time * RATE.wave1) % TAU,
        (time * RATE.wave2) % TAU,
        (time * RATE.twist) % TAU,
        (time * RATE.hue) % 2,
      );
      ctx.uniform1f(scene.uScroll, scroll * renderScale());
      ctx.uniform2f(scene.uPointer, pointer.x, pointer.y);
      ctx.uniform1f(scene.uIntensity, clampIntensity(intensityRef.current));
      ctx.uniform1f(scene.uThickness, clampThickness(thicknessRef.current));
      ctx.drawArrays(ctx.TRIANGLES, 0, 3);
      /* The canvas starts transparent and fades up on its first real frame,
         so there is never a pop from empty to lit. */
      if (!revealed) {
        revealed = true;
        canvas.style.opacity = '1';
      }
    };

    /* The still frame ignores scroll and pointer: no parallax means the ribbon
       sits where it sits. */
    const drawStill = () => {
      time = STILL_TIME;
      pointer.x = pointer.y = 0;
      draw(0);
    };

    const frame = (now: number) => {
      raf = 0;
      if (!running()) return;
      /* Capped so a stall slows the flow for a frame instead of jumping it. */
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      time += dt;
      const k = 1 - Math.pow(1 - POINTER_EASE, dt * 60);
      pointer.x += (pointer.tx - pointer.x) * k;
      pointer.y += (pointer.ty - pointer.y) * k;
      draw(window.scrollY);
      raf = requestAnimationFrame(frame);
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
      if (still) drawStill();
    };

    const resize = () => {
      const w = Math.max(1, Math.round(root.clientWidth * renderScale()));
      const h = Math.max(1, Math.round(root.clientHeight * renderScale()));
      if (w === width && h === height) return;
      width = w;
      height = h;
      /* Setting the size clears the buffer, so redraw at once rather than
         showing an empty frame until the next tick. */
      canvas.width = w;
      canvas.height = h;
      ctx.viewport(0, 0, w, h);
      if (still) drawStill();
      else draw(window.scrollY);
    };

    const onMove = (e: PointerEvent) => {
      /* A finger is scrolling, not pointing; bending toward it would jerk. */
      if (e.pointerType === 'touch' || !inView) return;
      const rect = root.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const nx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
      const ny = (0.5 - (e.clientY - rect.top) / rect.height) * 2;
      pointer.tx = Math.min(1.4, Math.max(-1.4, nx));
      pointer.ty = Math.min(1.4, Math.max(-1.4, ny));
    };

    const onVisibility = () => {
      hidden = document.hidden;
      sync();
    };
    const onReduce = (e: MediaQueryListEvent) => {
      still = e.matches;
      sync();
    };
    /* preventDefault tells the browser we want the context back. */
    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
      sync();
    };
    const onRestored = () => {
      scene = buildScene(ctx);
      if (!scene) {
        setFallback(true);
        return;
      }
      lost = false;
      width = height = 0;
      resize();
      sync();
    };

    redrawRef.current = () => {
      if (still && !lost) drawStill();
    };

    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    reduce.addEventListener('change', onReduce);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(resize);
      ro.observe(root);
    } else {
      window.addEventListener('resize', resize);
    }

    /* Off screen there is nobody to draw for, and the videos below want the
       GPU more than a ribbon nobody can see. */
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          inView = entries.some((entry) => entry.isIntersecting);
          sync();
        },
        { rootMargin: '120px 0px' },
      );
      io.observe(root);
    }

    resize();
    sync();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      redrawRef.current = null;
      ro?.disconnect();
      io?.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('visibilitychange', onVisibility);
      reduce.removeEventListener('change', onReduce);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      /* Release the program, not the context: a canvas keeps one context for
         life, and React's development double-mount would otherwise get a
         deliberately lost context back on the second run. */
      if (scene) destroyScene(ctx, scene);
      scene = null;
    };
  }, []);

  return (
    <div
      ref={rootRef}
      aria-hidden
      className={`pointer-events-none absolute inset-0 overflow-hidden${className ? ` ${className}` : ''}`}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ opacity: 0, transition: 'opacity 900ms ease' }}
      />
      {fallback && (
        <div
          className="absolute inset-0"
          style={{
            ...FALLBACK_STYLE,
            /* No tubes to thin here: a thinner ribbon reads as a fainter one. */
            opacity: clampIntensity(intensity) * Math.min(1, clampThickness(thickness)),
          }}
        />
      )}
    </div>
  );
}
